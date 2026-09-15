//! 执行请求与宿主注入事实。纯函数编译层不触盘：磁盘存在性/提权态等事实由宿主（WP-03 接线层）
//! 在调用边界注入（[自定] 载体；同向 Codex"执行边界才做 native 转换"，参考报告 §1.3）。

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 沙箱执行请求（命令半；env 由宿主经 SEC-080 清洗后注入，不在本结构——WP-01 边界，
/// 接线时见 WP-03 接缝⑭）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecRequest {
    /// 程序：绝对路径，或 PATH 裸名（裸名解析责任在宿主，[自定] 校验规则=含分隔符必须绝对）。
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 绝对规范化工作目录。
    pub cwd: PathBuf,
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
