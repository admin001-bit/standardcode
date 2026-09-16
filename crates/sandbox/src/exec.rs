//! 执行请求与宿主注入事实。纯函数编译层不触盘：磁盘存在性/提权态等事实由宿主（WP-03 接线层）
//! 在调用边界注入（[自定] 载体；同向 Codex"执行边界才做 native 转换"，参考报告 §1.3）。
//!
//! WP-02 扩：`env` 字段落地（执行面供给，代理键按策略剥离见 run.rs）；[`ExecOutput`] = 真跑结果。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 沙箱执行请求。env 由调用方经 SEC-080 清洗后供给（接缝⑭：沙箱路径不豁免清洗，
/// 执行层只再加码"策略网络=deny 时剥代理键"一道，run.rs::apply_proxy_policy）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecRequest {
    /// 程序：绝对路径，或 PATH 裸名（裸名解析责任在宿主，[自定] 校验规则=含分隔符必须绝对）。
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 绝对规范化工作目录。
    pub cwd: PathBuf,
    /// 子进程环境（入沙箱前面经策略代理剥离）。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl ExecRequest {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: cwd.into(),
            env: BTreeMap::new(),
        }
    }
}

/// 真跑产物（WP-02）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// 宿主注入事实集。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolicyFacts {
    /// 已存在的绝对路径（决定 mask 形状：已存在→只读绑定；不存在→空 tmpfs 遮蔽，防首次创建洞——
    /// 对位 Codex"subpath alone leaves a gap for first-time creation"，参考报告 §1.4(c)）。
    pub exists: BTreeSet<PathBuf>,
    /// Windows 后端已提权（deny-read 仅 elevated 可表达，§5.3(3) 教训清单）。
    pub elevated: bool,
}

impl PolicyFacts {
    pub fn exists<I, P>(paths: I) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self {
            exists: paths.into_iter().map(Into::into).collect(),
            elevated: false,
        }
    }
}
