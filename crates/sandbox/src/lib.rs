//! StandardCode 沙箱执行后端（L4 `sandbox-backend`，Rust 单点；v2.8 §5.2 行 223 / §5.3(3) 行 256-266 / ARCH-008 行 206 / ADR-002 / ADR-021）。
//!
//! - WP-01：策略编译器（纯函数）+ IPC 帧层 + `SandboxBackend` trait 签名。
//! - WP-02：三平台真隔离原语——macOS Seatbelt（sandbox-exec 真跑）/ Linux bwrap+seccomp
//!   两阶段（capabilities 清零 fail-hard + cBPF socket 过滤）/ Windows 受限令牌
//!   （WRITE_RESTRICTED）+ ACL capability-ACE。TS 宿主接线 = WP-03。
//!
//! 机制级参考（v2.8 §4.2 L4=Codex 独占；Apache-2.0，NOTICE 义务随 Q-9 处理）：`codex-rs/sandboxing`
//! 三层分离架构与平台形状——仅借架构与教训清单（§5.3(3) 行 266），命名与实现自研。引用：
//! `reports\A-一手核验\调研报告_Codex沙箱与OpenCode-Provider.md` §1.1–§1.8（A 级）。
//!
//! 所有 `[自定]` 形状在结果页 `D:\StandardCode\plan\T2-交付\M5-生产加固\M5-1-results.md`
//! 对应 WP 节偏差登记，供 V 判。

pub mod compile;
pub mod error;
pub mod exec;
pub mod ipc;
pub mod policy;
pub mod run;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "linux")]
pub mod seccomp;
#[cfg(windows)]
pub mod windows;

pub use compile::{compile, CompiledCommand, Platform, SandboxType, POLICY_SCHEMA_VERSION};
pub use error::{CompileError, FrameError, RunError};
pub use exec::{ExecOutput, ExecRequest, PolicyFacts};
pub use ipc::{Frame, FrameCodec, FrameKind, IPC_PROTOCOL_VERSION, MAX_FRAME_BYTES};
pub use policy::{
    Access, FileSystemPolicy, FsKind, LegacyMode, MetadataProtection, NetPolicy, PathShape,
    RootPath, SandboxBackend, SandboxPolicy, SandboxedChild,
};
pub use run::{run, run_with_self_exe, PROXY_ENV_KEYS};
