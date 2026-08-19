"""
router/eval_intent_model.py — Evaluate the intent classifier with train/test split.

Splits router/data/seed.jsonl into 80/20 train/test, trains the model,
and reports accuracy, precision, recall, and F1 per class plus overall.

Usage:
    python router/eval_intent_model.py
"""

from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

try:
    from sklearn.feature_extraction import HashingVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report, accuracy_score
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
            except json.JSONDecodeError:
                continue
            text = obj.get("text", "").strip()
            label = obj.get("label", "").strip()
            if text and label:
                texts.append(text)
                labels.append(label)
    return texts, labels


# ---------------------------------------------------------------------------
# Build pipeline (mirrors train_intent_model.py)
# ---------------------------------------------------------------------------
def make_pipeline() -> Pipeline:
    return Pipeline([
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    if not SEED_PATH.exists():
        print(f"ERROR: seed file not found: {SEED_PATH}", file=sys.stderr)
        sys.exit(1)

    texts, labels = load_seed(SEED_PATH)
    print(f"Loaded {len(texts)} samples from {SEED_PATH}")

    # 80/20 stratified split
    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels, test_size=0.2, random_state=42, stratify=labels
    )
    print(f"  Train: {len(X_train)}  Test: {len(X_test)}")

    print("Training ...")
    pipeline = make_pipeline()
    pipeline.fit(X_train, y_train)

    y_pred = pipeline.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"\nTest accuracy: {acc:.1%}")
    print("\nClassification report:")
    print(classification_report(y_test, y_pred))

    # Also test against the live model.pkl if it exists
    if MODEL_PATH.exists():
        print("--- Comparing against existing model.pkl ---")
        with MODEL_PATH.open("rb") as f:
            live = pickle.load(f)
        live_pred = live.predict(X_test)
        live_acc = accuracy_score(y_test, live_pred)
        print(f"  Existing model.pkl test accuracy: {live_acc:.1%}")
        if abs(live_acc - acc) > 0.01:
            print("  WARNING: accuracy differs from freshly trained model — seed data may have changed.")
        else:
            print("  OK: matches freshly trained model.")
    else:
        print("\nNo existing model.pkl found — training and saving now.")
        with MODEL_PATH.open("wb") as f:
            pickle.dump(pipeline, f)
        print(f"Saved to {MODEL_PATH}")


if __name__ == "__main__":
    main()
