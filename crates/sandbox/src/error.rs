//! 错误分型：一律 fail-closed——错误意味着**拒绝产生沙箱化 argv**，调用方不得退化为未沙箱执行
//! （v2.8 §5.3(3) 教训清单行 266"违规检测保守化"同面 / §0.5 B-12 行 54 沙箱 fail-closed）。

use std::path::PathBuf;

/// 策略编译层错误（WP-01）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompileError {
    #[error("路径不是绝对路径：{0}")]
    PathNotAbsolute(PathBuf),
    #[error("路径含 . 或 .. 成分（非规范化输入被拒）：{0}")]
    PathNotNormalized(PathBuf),
    #[error("命令（program）为空")]
    EmptyProgram,
    #[error(
        "可写根被拒：{path} 含深层符号链接成分（仅允许顶层系统别名，§5.3(3) 教训清单 symlink 面）"
    )]
    SymlinkRejected { path: PathBuf },
    #[error("可写根 {root} 落在受保护路径 {protected} 之下（deny 恒赢，不可开禁）")]
    RootUnderProtection { root: PathBuf, protected: PathBuf },
    #[error("策略合并失败：{0}")]
    MergeConflict(String),
    #[error("策略序列化失败：{0}")]
    Serialize(String),
    #[error("Windows legacy 受限令牌后端无法表达 deny-read（需 elevated 后端）：{0}")]
    DenyReadRequiresElevation(PathBuf),
}

/// IPC 帧层错误（ARCH-008；坏帧/超长/版本不符 → Err，调用方关通道，不得跳帧续读）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("帧超出字节上限：{size} > {max}")]
    TooLarge { size: usize, max: usize },
    #[error("帧不是 UTF-8")]
    InvalidUtf8,
    #[error("帧不是合法 JSON 对象")]
    NotJsonObject,
    #[error("帧字段缺失：{0}")]
    MissingField(&'static str),
    #[error("未知帧类型：{0}")]
    UnknownType(String),
    #[error("协议版本不符：得到 {got}，期望 {expected}")]
    VersionMismatch { got: u64, expected: u64 },
    #[error("帧字段类型错误：{0}")]
    InvalidField(&'static str),
    #[error("帧含裸换行")]
    EmbeddedNewline,
}

/// 执行层错误（WP-02 真跑；一律由调用方呈现，不得静默降级为未沙箱执行——B-12 fail-closed）。
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("编译层拒绝：{0}")]
    Compile(#[from] CompileError),
    #[error("子进程拉起失败（fail-closed，非绕过沙箱执行）：{0}")]
    Spawn(String),
    #[error("沙箱内层错误：{0}")]
    Inner(String),
    #[error("IO：{0}")]
    Io(#[from] std::io::Error),
    #[error("Windows 特权不足（CreateProcessAsUserW 需 SeAssignPrimaryToken/SeIncreaseQuota；实证 GH runner 与本地非提权 shell 皆无——BLK-04=①）：{0}")]
    Privilege(String),
}
