#!/usr/bin/env python3
"""GitHub Actions ワークフローの YAML 構文を検証する。

2026-07-01 に、Chatwork 通知メッセージの複数行文字列が `run: |` ブロック内で
カラム0から始まり、6ワークフローが startup_failure で丸1日全停止した事故の再発防止。

使い方:
    python scripts/validate-workflows.py        # 全 .github/workflows/*.yml を検証
终了コード: 0=全 OK / 1=1つ以上が構文エラー

CI（ci.yml）から呼ばれるほか、ワークフロー編集後はローカルでも実行すること。
"""
from __future__ import annotations

import glob
import sys

# Windows コンソール（cp932）でも絵文字・日本語を出力できるようにする
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except (AttributeError, ValueError):
    pass

try:
    import yaml
except ImportError:
    sys.stderr.write("PyYAML が必要です: pip install pyyaml\n")
    sys.exit(2)


def main() -> int:
    files = sorted(glob.glob(".github/workflows/*.yml")) + sorted(
        glob.glob(".github/workflows/*.yaml")
    )
    if not files:
        print("⚠️  .github/workflows/ にワークフローが見つかりません")
        return 0

    broken: list[tuple[str, str]] = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                yaml.safe_load(fh)
            print(f"OK      {f}")
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None)
            detail = f"line {mark.line + 1}" if mark else str(e).splitlines()[0]
            broken.append((f, detail))
            print(f"BROKEN  {f}  ({detail})")

    if broken:
        print("\n❌ YAML 構文エラーが見つかりました:")
        for f, detail in broken:
            print(f"   - {f}: {detail}")
        print(
            "\nヒント: run: | ブロック内の複数行メッセージはカラム0から始めないこと。"
            "\n        改行は NL=$'\\n' を定義して 1 行文字列に埋め込む。"
        )
        return 1

    print(f"\n✅ 全 {len(files)} ワークフローの YAML 構文 OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
