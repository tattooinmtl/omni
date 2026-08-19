"""
router/train_intent_model.py — Train the intent classifier from seed.jsonl.

Reads router/data/seed.jsonl (JSONL with "text" and "label" fields),
fits a sklearn HashingVectorizer + LogisticRegression pipeline,
and writes the pickle to router/model.pkl.

Usage:
    python router/train_intent_model.py
"""

from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

try:
    from sklearn.feature_extraction import HashingVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
except ImportError:
    print("ERROR: sklearn not installed. Run: pip install scikit-learn>=1.3", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROUTER_DIR = Path(__file__).parent.resolve()
SEED_PATH  = ROUTER_DIR / "data" / "seed.jsonl"
MODEL_PATH = ROUTER_DIR / "model.pkl"


# ---------------------------------------------------------------------------
# Load seed data
# ---------------------------------------------------------------------------
def load_seed(path: Path) -> tuple[list[str], list[str]]:
    texts, labels = [], []
    with path.open("r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARNING: skipping line {lineno} — bad JSON: {e}", file=sys.stderr)
                continue
            text = obj.get("text", "").strip()
            label = obj.get("label", "").strip()
            if not text or not label:
                print(f"WARNING: skipping line {lineno} — missing text or label", file=sys.stderr)
                continue
            texts.append(text)
            labels.append(label)
    return texts, labels


# ---------------------------------------------------------------------------
# Train
# ---------------------------------------------------------------------------
def train(texts: list[str], labels: list[str]) -> Pipeline:
    pipeline = Pipeline([
        ("hasher", HashingVectorizer(
            n_features=2**16,
            alternate_sign=False,
            ngram_range=(1, 2),
            stop_words="english",
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            C=1.0,
            class_weight="balanced",
            random_state=42,
        )),
    ])
    pipeline.fit(texts, labels)
    return pipeline


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if not SEED_PATH.exists():
        print(f"ERROR: seed file not found: {SEED_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading seed data from {SEED_PATH} ...")
    texts, labels = load_seed(SEED_PATH)
    print(f"  Loaded {len(texts)} samples")

    label_counts: dict[str, int] = {}
    for lbl in labels:
        label_counts[lbl] = label_counts.get(lbl, 0) + 1
    for lbl, count in sorted(label_counts.items()):
        print(f"  {lbl}: {count}")

    print("Training model ...")
    pipeline = train(texts, labels)

    # Evaluate on training data (quick sanity check)
    train_acc = pipeline.score(texts, labels)
    print(f"  Training accuracy: {train_acc:.1%}")

    print(f"Saving model to {MODEL_PATH} ...")
    with MODEL_PATH.open("wb") as f:
        pickle.dump(pipeline, f)

    print("Done.")


if __name__ == "__main__":
    main()
