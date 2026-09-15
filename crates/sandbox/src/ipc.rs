//! stdio JSON 帧层（ARCH-008 行 206：TS 宿主 ↔ Rust 沙箱执行器**只允许 stdio JSON 协议，禁止
//! FFI/N-API**；协议帧参照 Codex IPC——`IPC_PROTOCOL_VERSION=5`，
//! `evidence\harness参考项目\codex\codex-rs\windows-sandbox-rs\src\elevated\ipc_framed.rs:29`）。
//!
//! [自定] 传输形 = 行分隔单行 JSON（\n 定界）——与仓内 hooks/MCP stdio 形制同构，Node 侧消费零特殊化。
//! fail-closed：坏帧/超长/版本不符 → Err，调用方必须关通道（不得跳帧续读——半途坏流继续=被劫持面）。

use serde_json::{Map, Value};

use crate::error::FrameError;

/// 协议版本（v2.8 ARCH-008 点名引用值）。
pub const IPC_PROTOCOL_VERSION: u64 = 5;

/// 帧字节上限（不含定界换行）。[自定]=对齐仓内 MCP framer 的 16MB 形制（同源溢出防护）。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 帧类型。`hello` = 握手（双向版本核对）；`request`/`response`/`error` = RPC（spawn/
/// applyPolicy/teardown 方法面在 WP-03 宿主接线时定义消费）；`event` = 单向通知（exit/违规上报等，WP-02/03）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Hello,
    Request,
    Response,
    Event,
    Error,
}

impl FrameKind {
    fn as_str(self) -> &'static str {
        match self {
            FrameKind::Hello => "hello",
            FrameKind::Request => "request",
            FrameKind::Response => "response",
            FrameKind::Event => "event",
            FrameKind::Error => "error",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "hello" => Some(FrameKind::Hello),
            "request" => Some(FrameKind::Request),
            "response" => Some(FrameKind::Response),
            "event" => Some(FrameKind::Event),
            "error" => Some(FrameKind::Error),
            _ => None,
        }
    }
}

/// 统一信封：`{"v":5,"kind":…,"id":…?,"payload":…?}`。
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub v: u64,
    pub kind: FrameKind,
    /// 关联 id（request/response/error 必填；event 可选；hello 无）。
    pub id: Option<u64>,
    pub payload: Option<Value>,
}

impl Frame {
    pub fn hello() -> Self {
        let mut hello_payload = Map::new();
        hello_payload.insert("protocol".to_string(), Value::from(IPC_PROTOCOL_VERSION));
        Self {
            v: IPC_PROTOCOL_VERSION,
            kind: FrameKind::Hello,
            id: None,
            payload: Some(Value::Object(hello_payload)),
        }
    }

    pub fn request(id: u64, method: &str, params: Value) -> Self {
        let mut obj = Map::new();
        obj.insert("method".to_string(), Value::from(method));
        obj.insert("params".to_string(), params);
        Self {
            v: IPC_PROTOCOL_VERSION,
            kind: FrameKind::Request,
            id: Some(id),
            payload: Some(Value::Object(obj)),
        }
    }

    pub fn response(id: u64, result: Value) -> Self {
        let mut obj = Map::new();
        obj.insert("result".to_string(), result);
        Self {
            v: IPC_PROTOCOL_VERSION,
            kind: FrameKind::Response,
            id: Some(id),
            payload: Some(Value::Object(obj)),
        }
    }

    pub fn failure(id: u64, code: &str, message: &str) -> Self {
        let mut obj = Map::new();
        obj.insert("code".to_string(), Value::from(code));
        obj.insert("message".to_string(), Value::from(message));
        Self {
            v: IPC_PROTOCOL_VERSION,
            kind: FrameKind::Error,
            id: Some(id),
            payload: Some(Value::Object(obj)),
        }
    }

    pub fn event(name: &str, data: Value) -> Self {
        let mut obj = Map::new();
        obj.insert("name".to_string(), Value::from(name));
        obj.insert("data".to_string(), data);
        Self {
            v: IPC_PROTOCOL_VERSION,
            kind: FrameKind::Event,
            id: None,
            payload: Some(Value::Object(obj)),
        }
    }

    /// 握手核对：hello 帧 payload.protocol 必须等于本端版本；不符 = VersionMismatch（发送端
    /// 已声明协议不兼容，接收方回 error 帧后必须关通道——fail-closed）。
    pub fn check_hello(frame: &Frame) -> Result<(), FrameError> {
        let payload = frame
            .payload
            .as_ref()
            .ok_or(FrameError::MissingField("payload"))?;
        let proto = payload
            .get("protocol")
            .ok_or(FrameError::InvalidField("payload.protocol"))?
            .as_u64()
            .ok_or(FrameError::InvalidField("payload.protocol"))?;
        if proto != IPC_PROTOCOL_VERSION {
            return Err(FrameError::VersionMismatch {
                got: proto,
                expected: IPC_PROTOCOL_VERSION,
            });
        }
        Ok(())
    }
}

/// 帧编解码器（无状态）。
pub struct FrameCodec;

impl FrameCodec {
    /// Frame → 单行 JSON + `\n`。超 [`MAX_FRAME_BYTES`] → Err（不产出截断帧）。
    pub fn encode(frame: &Frame) -> Result<Vec<u8>, FrameError> {
        let mut obj = Map::new();
        obj.insert("v".to_string(), Value::from(frame.v));
        obj.insert("kind".to_string(), Value::from(frame.kind.as_str()));
        if let Some(id) = frame.id {
            obj.insert("id".to_string(), Value::from(id));
        }
        if let Some(payload) = &frame.payload {
            obj.insert("payload".to_string(), payload.clone());
        }
        let text =
            serde_json::to_string(&Value::Object(obj)).map_err(|_| FrameError::NotJsonObject)?;
        let size = text.len();
        if size > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge {
                size,
                max: MAX_FRAME_BYTES,
            });
        }
        // 防御断言：compact 序列化不含裸换行（字符串内换行被 \n 转义）；若破坏即拒发。
        if text.contains('\n') {
            return Err(FrameError::EmbeddedNewline);
        }
        let mut bytes = text.into_bytes();
        bytes.push(b'\n');
        Ok(bytes)
    }

    /// 单帧解码（行含尾部 `\n`/`\r\n` 容忍）。全部校验 fail-closed。
    pub fn decode(line: &[u8]) -> Result<Frame, FrameError> {
        let mut body = line;
        if body.ends_with(b"\n") {
            body = &body[..body.len() - 1];
            if body.ends_with(b"\r") {
                body = &body[..body.len() - 1];
            }
        }
        if body.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge {
                size: body.len(),
                max: MAX_FRAME_BYTES,
            });
        }
        let text = std::str::from_utf8(body).map_err(|_| FrameError::InvalidUtf8)?;
        let parsed: Value = serde_json::from_str(text).map_err(|_| FrameError::NotJsonObject)?;
        let obj = parsed.as_object().ok_or(FrameError::NotJsonObject)?;
        let v = obj
            .get("v")
            .ok_or(FrameError::MissingField("v"))?
            .as_u64()
            .ok_or(FrameError::InvalidField("v"))?;
        if v != IPC_PROTOCOL_VERSION {
            return Err(FrameError::VersionMismatch {
                got: v,
                expected: IPC_PROTOCOL_VERSION,
            });
        }
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or(FrameError::MissingField("kind"))?;
        let kind =
            FrameKind::parse(kind).ok_or_else(|| FrameError::UnknownType(kind.to_string()))?;
        let id = match obj.get("id") {
            None | Some(Value::Null) => None,
            Some(Value::Number(n)) => Some(n.as_u64().ok_or(FrameError::InvalidField("id"))?),
            Some(_) => return Err(FrameError::InvalidField("id")),
        };
        if matches!(
            kind,
            FrameKind::Request | FrameKind::Response | FrameKind::Error
        ) && id.is_none()
        {
            return Err(FrameError::MissingField("id"));
        }
        let payload = obj.get("payload").cloned();
        if kind == FrameKind::Hello {
            let hello_payload = payload
                .as_ref()
                .ok_or(FrameError::MissingField("payload"))?;
            let proto = hello_payload
                .get("protocol")
                .and_then(Value::as_u64)
                .ok_or(FrameError::InvalidField("payload.protocol"))?;
            if proto != IPC_PROTOCOL_VERSION {
                return Err(FrameError::VersionMismatch {
                    got: proto,
                    expected: IPC_PROTOCOL_VERSION,
                });
            }
        }
        Ok(Frame {
            v,
            kind,
            id,
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_all_kinds() {
        let frames = vec![
            Frame::hello(),
            Frame::request(7, "spawn", json!({"policy": {}})),
            Frame::response(7, json!({"pid": 42})),
            Frame::failure(7, "denied", "fail-closed"),
            Frame::event("exit", json!({"code": 0})),
        ];
        for f in frames {
            let bytes = FrameCodec::encode(&f).unwrap();
            assert_eq!(bytes.last(), Some(&b'\n'));
            assert_eq!(FrameCodec::decode(&bytes).unwrap(), f);
        }
    }

    #[test]
    fn decode_tolerates_crlf_and_rejects_garbage() {
        let ok =
            FrameCodec::decode(b"{\"v\":5,\"kind\":\"event\",\"payload\":{\"name\":\"x\"}}\r\n");
        assert!(ok.is_ok());
        assert_eq!(
            FrameCodec::decode(b"not json\n").unwrap_err(),
            FrameError::NotJsonObject
        );
        assert_eq!(
            FrameCodec::decode(b"[1,2]\n").unwrap_err(),
            FrameError::NotJsonObject
        );
        assert_eq!(
            FrameCodec::decode(b"{}\n").unwrap_err(),
            FrameError::MissingField("v")
        );
        assert_eq!(
            FrameCodec::decode(b"{\"v\":5}\n").unwrap_err(),
            FrameError::MissingField("kind")
        );
    }

    #[test]
    fn version_mismatch_fails_closed() {
        assert_eq!(
            FrameCodec::decode(b"{\"v\":4,\"kind\":\"request\",\"id\":1}\n").unwrap_err(),
            FrameError::VersionMismatch {
                got: 4,
                expected: 5
            }
        );
        let mut f = Frame::hello();
        f.v = 6;
        assert!(matches!(
            FrameCodec::encode(&f).and_then(|b| FrameCodec::decode(&b)),
            Err(FrameError::VersionMismatch { got: 6, .. })
        ));
    }

    #[test]
    fn unknown_type_and_id_rules() {
        assert_eq!(
            FrameCodec::decode(b"{\"v\":5,\"kind\":\"bogus\"}\n").unwrap_err(),
            FrameError::UnknownType("bogus".to_string())
        );
        // request/response/error 缺 id=坏帧；event 可无 id
        assert_eq!(
            FrameCodec::decode(b"{\"v\":5,\"kind\":\"request\"}\n").unwrap_err(),
            FrameError::MissingField("id")
        );
        assert_eq!(
            FrameCodec::decode(b"{\"v\":5,\"kind\":\"request\",\"id\":null}\n").unwrap_err(),
            FrameError::MissingField("id")
        );
        assert!(
            FrameCodec::decode(b"{\"v\":5,\"kind\":\"event\",\"payload\":{\"name\":\"x\"}}")
                .is_ok()
        );
    }

    #[test]
    fn size_guard_exact_boundary() {
        // 恰达上限可过；超限 1 字节拒（encode 与 decode 两侧同闸）。经验法求基线：
        // 先编码空 payload 帧求固定开销（'x' 串无转义，开销随长度线性），再补齐到恰限。
        let base = FrameCodec::encode(&Frame::event("e", json!({"p": ""})))
            .unwrap()
            .len()
            - 1; // 去定界换行
        let pad = MAX_FRAME_BYTES - base;
        let f = Frame::event("e", json!({"p": "x".repeat(pad)}));
        let bytes = FrameCodec::encode(&f).unwrap();
        assert_eq!(bytes.len() - 1, MAX_FRAME_BYTES);
        assert_eq!(FrameCodec::decode(&bytes).unwrap(), f);
        let over = "x".repeat(pad + 1);
        assert!(matches!(
            FrameCodec::encode(&Frame::event("e", json!({"p": over}))),
            Err(FrameError::TooLarge { .. })
        ));
        assert!(matches!(
            FrameCodec::decode(&vec![b'a'; MAX_FRAME_BYTES + 3]),
            Err(FrameError::TooLarge { .. })
        ));
    }

    #[test]
    fn hello_check_semantics() {
        Frame::check_hello(&Frame::hello()).unwrap();
        let bad = Frame {
            payload: Some(json!({"protocol": 4})),
            ..Frame::hello()
        };
        assert_eq!(
            Frame::check_hello(&bad).unwrap_err(),
            FrameError::VersionMismatch {
                got: 4,
                expected: 5
            }
        );
        let missing = Frame {
            payload: Some(json!({})),
            ..Frame::hello()
        };
        assert_eq!(
            Frame::check_hello(&missing).unwrap_err(),
            FrameError::InvalidField("payload.protocol")
        );
    }
}
