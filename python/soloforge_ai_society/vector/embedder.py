# -*- coding: utf-8 -*-
"""
SoloForge AI Society - TF-IDF Embedder

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  AI 社会专用向量生成 ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

使用 TF-IDF + 随机投影生成文本向量
无需外部 ML 模型，纯 Python 实现（适配 Python 3.12.10）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import math
import re
from collections import Counter
from typing import List

import numpy as np


# 停用词列表
STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for",
    "from", "has", "he", "in", "is", "it", "its", "of", "on",
    "that", "the", "to", "was", "were", "will", "with",
    "this", "but", "they", "have", "had", "what", "when",
    "where", "who", "which", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some",
    "such", "no", "nor", "not", "only", "own", "same", "so",
    "than", "too", "very", "just", "can", "should", "now",
    # 中文停用词
    "的", "了", "在", "是", "我", "有", "和", "就", "不",
    "人", "都", "一", "一个", "上", "也", "很", "到", "说",
    "要", "去", "你", "会", "着", "没有", "看", "好", "自己",
    "这", "那", "么", "为什么", "什么", "怎么", "如何",
}


class TFIDFEmbedder:
    """
    TF-IDF 向量生成器

    使用 TF-IDF 算法 + 随机投影生成文本向量

    特点：
    - 无需外部 ML 模型
    - 纯 Python/NumPy 实现
    - 可在 Python 3.12 上运行
    """

    def __init__(self, dim: int = 128, min_df: int = 2, max_df: float = 0.95):
        """
        初始化

        Args:
            dim: 向量维度
            min_df: 最小文档频率
            max_df: 最大文档频率比例
        """
        self.dim = dim
        self.min_df = min_df
        self.max_df = max_df

        self.vocabulary: dict[str, int] = {}
        self.idf: np.ndarray = None
        self.projection_matrix: np.ndarray = None
        self.is_fitted = False

    def _tokenize(self, text: str) -> List[str]:
        """
        分词

        支持中英文混合文本
        """
        if not text:
            return []

        # 转换为小写
        text = text.lower()

        # 提取中文字符（Unicode范围）
        chinese_chars = re.findall(r'[\u4e00-\u9fff]+', text)

        # 提取英文单词
        english_words = re.findall(r'[a-zA-Z]+', text)

        tokens = []

        # 处理中文字符（按字符切分）
        for chars in chinese_chars:
            tokens.extend(list(chars))

        # 处理英文单词
        for word in english_words:
            if word not in STOP_WORDS and len(word) > 1:
                tokens.append(word)

        # 过滤停用词
        tokens = [t for t in tokens if t not in STOP_WORDS and len(t) > 1]

        return tokens

    def _compute_tf(self, tokens: List[str]) -> dict[str, float]:
        """计算词频"""
        counter = Counter(tokens)
        total = len(tokens)
        return {word: count / total for word, count in counter.items()}

    def _compute_idf(self, documents: List[List[str]]) -> np.ndarray:
        """计算逆文档频率"""
        n_docs = len(documents)
        df = Counter()

        for doc in documents:
            unique_tokens = set(doc)
            for token in unique_tokens:
                df[token] += 1

        idf = np.zeros(len(self.vocabulary))
        for token, idx in self.vocabulary.items():
            # 平滑防止除零
            idf[idx] = math.log((n_docs + 1) / (df[token] + 1)) + 1

        return idf

    def _tfidf_to_vector(self, tf: dict[str, float]) -> np.ndarray:
        """将 TF-IDF 转换为向量"""
        vector = np.zeros(self.dim)

        # 计算 TF-IDF
        tfidf_scores = []
        for word, tf_score in tf.items():
            if word in self.vocabulary:
                idx = self.vocabulary[word]
                tfidf_scores.append((idx, tf_score * self.idf[idx]))

        # 如果没有匹配词，返回随机向量
        if not tfidf_scores:
            return np.random.randn(self.dim) * 0.1

        # 使用随机投影降维
        # 取最高权重的词
        tfidf_scores.sort(key=lambda x: x[1], reverse=True)
        top_k = min(20, len(tfidf_scores))  # 最多取 20 个词

        for idx, score in tfidf_scores[:top_k]:
            # 加权随机投影
            vector += self.projection_matrix[:, idx] * score

        # L2 归一化
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm

        return vector

    def fit(self, texts: List[str]) -> "TFIDFEmbedder":
        """
        训练模型

        Args:
            texts: 训练文本列表
        """
        # 分词
        documents = [self._tokenize(text) for text in texts]

        # 构建词汇表
        df = Counter()
        for doc in documents:
            for token in set(doc):
                df[token] += 1

        # 过滤低频和高频词
        n_docs = len(documents)
        vocab_words = [
            word for word, count in df.items()
            if count >= self.min_df and count / n_docs <= self.max_df
        ]

        # 限制词汇表大小
        if len(vocab_words) > self.dim * 10:
            vocab_words = sorted(vocab_words, key=lambda w: df[w], reverse=True)[: self.dim * 10]

        self.vocabulary = {word: idx for idx, word in enumerate(vocab_words)}

        # 计算 IDF
        self.idf = self._compute_idf(documents)

        # 生成随机投影矩阵
        # 从 vocabulary 到 dim 的随机映射
        np.random.seed(42)  # 可重复性
        self.projection_matrix = np.random.randn(self.dim, len(vocab_words)) * 0.1

        self.is_fitted = True
        return self

    def embed(self, text: str) -> np.ndarray:
        """
        生成向量

        Args:
            text: 输入文本

        Returns:
            向量 (dim,)
        """
        if not self.is_fitted:
            # 未训练时返回随机向量
            return np.random.randn(self.dim) * 0.1

        tokens = self._tokenize(text)
        tf = self._compute_tf(tokens)
        return self._tfidf_to_vector(tf)

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """
        批量生成向量

        Args:
            texts: 输入文本列表

        Returns:
            向量矩阵 (n, dim)
        """
        return np.array([self.embed(text) for text in texts])


# 全局实例
_embedder: TFIDFEmbedder = None


def get_embedder(dim: int = 128) -> TFIDFEmbedder:
    """获取全局嵌入器实例"""
    global _embedder
    if _embedder is None:
        _embedder = TFIDFEmbedder(dim=dim)
    return _embedder


def set_embedder(embedder: TFIDFEmbedder) -> None:
    """设置全局嵌入器"""
    global _embedder
    _embedder = embedder
