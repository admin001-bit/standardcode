//! StandardCode 沙箱执行后端（L4 `sandbox-backend`，Rust 单点；v2.8 §5.2 行 223 / §5.3(3) 行 256-266 / ARCH-008 行 206 / ADR-002 / ADR-021）。
//!
//! WP-01 范围：策略编译器（命令+策略→argv 纯函数，双轴三档 + legacy 单轴兼容入口）、stdio JSON IPC 帧层、
//! `SandboxBackend` trait 签名。平台原生隔离原语 = WP-02；TS 宿主接线 = WP-03。
//!
//! 机制级参考（v2.8 §4.2 L4=Codex 独占；Apache-2.0，NOTICE 义务随 Q-9 处理）：`codex-rs/sandboxing` 三层分离
//! 架构与平台形状——仅借架构与教训清单（§5.3(3) 行 266），命名与实现自研。引用：
//! `reports\A-一手核验\调研报告_Codex沙箱与OpenCode-Provider.md` §1.1–§1.8（A 级）。
//!
//! 所有 `[自定]` 形状在结果页 `D:\StandardCode\plan\T2-交付\M5-生产加固\M5-1-results.md` WP-01 节偏差登记，供 V 判。

pub mod compile;
pub mod error;
pub mod exec;
pub mod ipc;
pub mod policy;

pub use compile::{compile, CompiledCommand, Platform, SandboxType, POLICY_SCHEMA_VERSION};
pub use error::{CompileError, FrameError};
pub use exec::{ExecRequest, PolicyFacts};
pub use ipc::{Frame, FrameCodec, FrameKind, IPC_PROTOCOL_VERSION, MAX_FRAME_BYTES};
pub use policy::{
    Access, FileSystemPolicy, FsKind, LegacyMode, MetadataProtection, NetPolicy, PathShape,
    RootPath, SandboxBackend, SandboxPolicy, SandboxedChild,
};
