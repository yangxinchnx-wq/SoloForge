# -*- coding: utf-8 -*-
"""
SoloForge AI Society - 配置管理

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用配置 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本配置文件仅用于 AI 社会模块，与主项目配置隔离。

数据库隔离：
- 路径：data/ai_society/  （与主项目 data/soloforge_db/ 完全分开）
- SQLite：ai_society.db    （结构化数据）
- LanceDB：social_memory   （向量数据）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class AISocietyConfig:
    """AI 社会配置"""

    # 数据目录
    data_dir: Path = field(default_factory=lambda: Path("./data/ai_society"))

    # SQLite 配置
    sqlite_db_name: str = "ai_society.db"

    # LanceDB 配置
    lancedb_name: str = "social_memory.lance"

    # 向量配置
    vector_dim: int = 128  # TF-IDF 向量维度

    # 日志配置
    log_level: str = "INFO"

    # 经济系统配置
    initial_credits: int = 1000  # 初始信用分
    credits_per_hour: int = 1000  # 每小时配额

    # 信誉配置
    reputation_high_threshold: float = 0.8  # 高信誉阈值
    reputation_low_threshold: float = 0.5   # 低信誉阈值

    # 联盟配置
    coalition_max_lifetime: int = 3600  # 最大生命周期（秒）

    def __post_init__(self):
        """确保数据目录存在"""
        self.data_dir = Path(self.data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    @property
    def sqlite_path(self) -> Path:
        """SQLite 数据库路径"""
        return self.data_dir / self.sqlite_db_name

    @property
    def lancedb_path(self) -> Path:
        """LanceDB 数据库路径"""
        return self.data_dir / self.lancedb_name


# 全局配置实例
_config: Optional[AISocietyConfig] = None


def get_config() -> AISocietyConfig:
    """获取全局配置"""
    global _config
    if _config is None:
        _config = AISocietyConfig()
    return _config


def set_config(config: AISocietyConfig) -> None:
    """设置全局配置"""
    global _config
    _config = config
