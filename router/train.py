"""
router/train.py — Train the Omni intent classifier.

Usage:
    python router/train.py           # train + save model.pkl
    python router/train.py --eval    # train + print held-out accuracy

Reads labeled examples from router/data/seed.jsonl.
Each line: {"text": "...", "label": "coding|assistant"}

The model is a sklearn hashing-vectoriser + logistic regression — tiny,
trains in milliseconds, loads instantly, sub-ms inference.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).parent
SEED_PATH   = SIDECAR_DIR / "data" / "seed.jsonl"
MODEL_PATH  = SIDECAR_DIR / "model.pkl"


def load_data(path: Path) -> tuple[list[str], list[str]]:
    texts, labels = [], []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            texts.append(obj["text"])
            labels.append(obj["label"])
    return texts, labels


def build_pipeline():
    from sklearn.pipeline import Pipeline
    from sklearn.feature_extraction.text import HashingVectorizer
    from sklearn.linear_model import LogisticRegression

    return Pipeline([
        ("vec", HashingVectorizer(
            analyzer="char_wb",
            ngram_range=(3, 5),
            n_features=2**16,
            norm="l2",
            alternate_sign=False,
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            C=1.0,
            solver="lbfgs",
        )),
    ])


def train(eval_mode: bool = False) -> None:
    texts, labels = load_data(SEED_PATH)
    print(f"Loaded {len(texts)} examples from {SEED_PATH}")

    if eval_mode:
        from sklearn.model_selection import cross_val_score
        import numpy as np
        pipeline = build_pipeline()
        scores = cross_val_score(pipeline, texts, labels, cv=5, scoring="accuracy")
        print(f"5-fold CV accuracy: {scores.mean():.3f} ± {scores.std():.3f}")

    pipeline = build_pipeline()
    pipeline.fit(texts, labels)

    with MODEL_PATH.open("wb") as f:
        pickle.dump(pipeline, f)
    print(f"Saved model -> {MODEL_PATH}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", action="store_true", help="Run cross-validation before saving")
    args = parser.parse_args()
    train(eval_mode=args.eval)
