"""README 用の図を生成する。

文字幅を推測すると日本語ラベルが重なるため、Pillow で実測してから
SVG を組み立てる。描画は「背景 → 文字」の 2 パスに分け、
ハイライトが文字を覆わないようにする。

使い方:
    python3 scripts/make_diagrams.py
    rsvg-convert -z 2 docs/assets/architecture.svg -o docs/assets/architecture.png
    rsvg-convert -z 2 docs/assets/hash-chain.svg -o docs/assets/hash-chain.png
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass

from PIL import ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

JP_FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"
JP_BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
MONO_FONT = "/System/Library/Fonts/Menlo.ttc"

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def width(text: str, path: str, size: int) -> float:
    return font(path, size).getlength(text)


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


@dataclass
class Palette:
    bg: str = "#ffffff"
    text: str = "#1f2328"
    muted: str = "#59636e"
    border: str = "#d0d7de"
    panel: str = "#f6f8fa"
    aws: str = "#c7511f"
    aws_bg: str = "#fff3e8"
    store: str = "#0969da"
    store_bg: str = "#e8f1ff"
    guard: str = "#1a7f37"
    guard_bg: str = "#e9f7ee"
    audit: str = "#8250df"
    audit_bg: str = "#f4eeff"
    danger: str = "#cf222e"
    danger_bg: str = "#ffebe9"
    ok: str = "#1a7f37"


P = Palette()


class Canvas:
    """背景パスと文字パスを分けて持つキャンバス。"""

    def __init__(self, w: int, h: int) -> None:
        self.w = w
        self.h = h
        self.bg: list[str] = [f'<rect width="{w}" height="{h}" fill="{P.bg}"/>']
        self.fg: list[str] = []
        self.defs: list[str] = []

    def rect(self, x: float, y: float, w: float, h: float, *, fill: str, stroke: str | None = None,
             rx: float = 10, opacity: float = 1.0, width_px: float = 1.2) -> None:
        stroke_attr = f' stroke="{stroke}" stroke-width="{width_px}"' if stroke else ""
        self.bg.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" '
            f'fill="{fill}" opacity="{opacity}"{stroke_attr}/>'
        )

    def text(self, x: float, y: float, value: str, *, size: int = 14, color: str | None = None,
             bold: bool = False, mono: bool = False, anchor: str = "start") -> None:
        family = "Menlo, monospace" if mono else "Hiragino Sans, Hiragino Kaku Gothic Pro, sans-serif"
        weight = ' font-weight="600"' if bold else ""
        self.fg.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{color or P.text}" '
            f'font-family="{family}"{weight} text-anchor="{anchor}" xml:space="preserve">{esc(value)}</text>'
        )

    def arrow(self, x1: float, y1: float, x2: float, y2: float, *, color: str | None = None,
              dashed: bool = False, label: str | None = None) -> None:
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        self.bg.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color or P.muted}" '
            f'stroke-width="1.8" marker-end="url(#arrow)"{dash}/>'
        )
        if label:
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            tw = width(label, JP_FONT, 12)
            self.bg.append(
                f'<rect x="{mx - tw / 2 - 4:.1f}" y="{my - 9:.1f}" width="{tw + 8:.1f}" height="18" '
                f'rx="4" fill="{P.bg}"/>'
            )
            self.text(mx, my + 4, label, size=12, color=P.muted, anchor="middle")

    def render(self) -> str:
        defs = (
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{P.muted}"/></marker></defs>'
        )
        return "\n".join(
            [
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
                f'viewBox="0 0 {self.w} {self.h}" font-family="Hiragino Sans, sans-serif">',
                defs,
                *self.bg,
                *self.fg,
                "</svg>",
            ]
        )


def box_with_title(c: Canvas, x: float, y: float, w: float, h: float, title: str, lines: list[str], *,
                   color: str, fill: str, title_size: int = 15, line_size: int = 12) -> None:
    c.rect(x, y, w, h, fill=fill, stroke=color, rx=10)
    c.text(x + 14, y + 24, title, size=title_size, color=color, bold=True)
    for index, line in enumerate(lines):
        c.text(x + 14, y + 46 + index * 18, line, size=line_size, color=P.text)


# ---------------------------------------------------------------------------
# 1. アーキテクチャ図
# ---------------------------------------------------------------------------

def build_architecture() -> str:
    c = Canvas(1240, 800)

    title = "電帳法対応 証憑アーカイブの構成"
    c.text(36, 42, title, size=22, bold=True)
    c.text(36 + width(title, JP_BOLD, 22) + 16, 42, "— サーバーレス / イミュータブル / 検証可能", size=14, color=P.muted)

    # 利用者
    box_with_title(c, 36, 76, 250, 92, "利用者・経理システム", ["経理担当者の取り込み", "税務調査対応者の検索・DL"],
                   color=P.muted, fill=P.panel)

    # ローカル実行（AWS なしでも同じコードが動く）
    box_with_title(
        c, 36, 190, 250, 122, "ローカル実行（AWS なし）",
        ["ファイルアダプタ + CLI", "demo / CI で E2E を実行", "同じ Archive インタフェース"],
        color=P.audit, fill=P.audit_bg,
    )

    # Lambda 群
    lambdas = [
        ("ingest", "検証 → ハッシュ → 保存 → 台帳追記"),
        ("search", "検索要件の 3 項目で検索"),
        ("export", "CSV / JSON（ダウンロードの求め）"),
        ("verify", "日次でチェーン全体を再検証"),
    ]
    lx, ly, lw, lh = 330, 88, 300, 44
    c.text(lx, 66, "AWS Lambda（ポート & アダプタでローカルと同じコード）", size=12, color=P.aws)
    for index, (name, description) in enumerate(lambdas):
        y = ly + index * (lh + 8)
        c.rect(lx, y, lw, lh, fill=P.aws_bg, stroke=P.aws, rx=8)
        c.text(lx + 14, y + 27, name, size=14, color=P.aws, bold=True, mono=True)
        c.text(lx + 14 + 72, y + 26, description, size=12, color=P.text)

    # 保存層
    box_with_title(
        c, 700, 76, 300, 118, "S3（Object Lock / WORM）",
        [
            "保持モード: COMPLIANCE",
            "保持期間: 2,557 日（7 年）",
            "暗号化: KMS / TLS 必須",
            "本体とメタデータを内容アドレスで保存",
        ],
        color=P.store, fill=P.store_bg,
    )
    box_with_title(
        c, 700, 208, 300, 124, "DynamoDB（台帳と索引）",
        [
            "台帳: 追記専用のハッシュチェーン",
            "追記はトランザクションで排他制御",
            "索引: 日付・金額・取引先 + 複合 2 種",
            "PITR / 暗号化",
        ],
        color=P.store, fill=P.store_bg,
    )
    box_with_title(c, 700, 346, 300, 76, "KMS", ["CMK（キーローテーション有効）", "保存データと監査ログを暗号化"],
                   color=P.store, fill=P.store_bg)

    # ガードレール（横長の 1 パネル。矢印を増やして図を読みにくくしない）
    c.rect(36, 340, 594, 200, fill=P.guard_bg, stroke=P.guard, rx=10)
    c.text(50, 366, "ガードレール", size=15, color=P.guard, bold=True)
    guards = [
        ("CloudTrail", "S3 データイベントを記録し、操作の証跡を残す"),
        ("EventBridge", "日次スケジュールで verify を自動実行する"),
        ("CloudWatch", "チェーン破損をアラームで通知する"),
        ("Step Functions", "一括取り込み（Map + 再試行 + 失敗経路）"),
    ]
    for index, (name, description) in enumerate(guards):
        y = 392 + index * 34
        c.text(50, y, name, size=13, color=P.guard, bold=True, mono=True)
        c.text(50 + 118, y, description, size=12, color=P.text)

    # 適合性検証とレポート
    box_with_title(
        c, 330, 570, 670, 104, "適合性検証エンジン（このリポジトリの中心）",
        [
            "電帳法の要件をルール化し、アーカイブの状態と CDK が合成したインフラ定義を機械検証する。",
            "真実性 / 可視性 / 検索要件 / 保存期間 / 税務調査対応 / 監査証跡の 6 区分・20 ルール。",
            "判定は pass / fail / n/a を根拠（証跡）付きで返し、総合判定と終了コードを決める。",
        ],
        color=P.audit, fill=P.audit_bg,
    )
    box_with_title(c, 1030, 570, 174, 104, "監査レポート", ["Markdown / JSON", "CI で毎回実行", "不適合なら exit 1"],
                   color=P.audit, fill=P.audit_bg)

    # 矢印
    c.arrow(286, 122, 326, 122, label="HTTPS")
    c.arrow(630, 106, 696, 116, label="保存")
    c.arrow(630, 150, 696, 254, label="追記")
    c.arrow(850, 346, 850, 334)
    c.arrow(850, 422, 850, 566, label="監査")
    c.arrow(1000, 622, 1026, 622)

    c.text(36, 714, "同じアプリケーションコードが、ローカルのファイルアダプタでも AWS アダプタでも動く（ポート & アダプタ）。",
           size=13, color=P.muted)
    c.text(36, 740, "そのため CI では AWS 資格情報なしで、取り込み → 検索 → 改ざん検知 → 適合性監査までを実際に実行して検証している。",
           size=13, color=P.muted)

    return c.render()


# ---------------------------------------------------------------------------
# 2. ハッシュチェーン図
# ---------------------------------------------------------------------------

def build_hash_chain() -> str:
    c = Canvas(1180, 560)

    c.text(36, 44, "ハッシュチェーンによる改ざん検知", size=22, bold=True)
    c.text(36 + width("ハッシュチェーンによる改ざん検知", JP_BOLD, 22) + 16, 44,
           "— 1 件の変更でも、以降のハッシュがすべて食い違う", size=14, color=P.muted)

    # 正常時
    c.text(36, 96, "正常な状態", size=15, color=P.ok, bold=True)
    entries = [
        ("第 1 項", "h1 = H(data1, prev=0…0)", P.ok, P.guard_bg),
        ("第 2 項", "h2 = H(data2, prev=h1)", P.ok, P.guard_bg),
        ("第 3 項", "h3 = H(data3, prev=h2)", P.ok, P.guard_bg),
    ]
    bx, by, bw, bh = 36, 116, 268, 78
    for index, (seq, formula, color, fill) in enumerate(entries):
        x = bx + index * (bw + 34)
        c.rect(x, by, bw, bh, fill=fill, stroke=color, rx=10)
        c.text(x + 16, by + 26, seq, size=15, color=color, bold=True)
        c.text(x + 16, by + 50, formula, size=12, color=P.text, mono=True)
        c.text(x + 16, by + 68, "✓ 再計算値と一致", size=11, color=color)
        if index < len(entries) - 1:
            c.arrow(x + bw + 4, by + bh / 2, x + bw + 30, by + bh / 2)

    # 改ざん時
    c.text(36, 244, "第 2 項の保存データを 1 バイト改ざんした場合", size=15, color=P.danger, bold=True)
    tampered = [
        ("第 1 項", "h = h1（一致）", P.ok, P.guard_bg),
        ("第 2 項", "h2' ≠ H(data2', prev=h1)", P.danger, P.danger_bg),
        ("第 3 項", "h3' ≠ H(data3, prev=h2)", P.danger, P.danger_bg),
    ]
    ty = 264
    for index, (seq, formula, color, fill) in enumerate(tampered):
        x = bx + index * (bw + 34)
        c.rect(x, ty, bw, bh, fill=fill, stroke=color, rx=10)
        c.text(x + 16, ty + 26, seq, size=15, color=color, bold=True)
        c.text(x + 16, ty + 50, formula, size=12, color=color if color == P.danger else P.text, mono=True)
        c.text(x + 16, ty + 68, "✓ 一致" if color == P.ok else "✗ 不一致を検出", size=11, color=color)
        if index < len(tampered) - 1:
            c.arrow(x + bw + 4, ty + bh / 2, x + bw + 30, ty + bh / 2)

    # 検出結果
    box_with_title(
        c, 36, 372, 1108, 104, "検証結果（verify コマンドの出力）",
        [
            "状態: broken / 検出位置: 第 2 項（該当する証憑ID）",
            "理由: content-mismatch",
            "期待: 3f9a…（保存時のハッシュ）    実際: 8c21…（再計算したハッシュ）",
        ],
        color=P.danger, fill=P.danger_bg,
    )

    c.text(36, 512, "改ざんを検知できるだけでなく、どの証憑のどの位置で壊れたかを特定できる。",
           size=13, color=P.muted)
    c.text(36, 534, "S3 Object Lock（WORM）は改ざん自体を拒否し、ハッシュチェーンは万一の破損・内部犯行を事後検知する。",
           size=13, color=P.muted)

    return c.render()


def write(name: str, svg: str) -> None:
    target = ASSETS / f"{name}.svg"
    target.write_text(svg, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} ({len(svg)} bytes)")


if __name__ == "__main__":
    write("architecture", build_architecture())
    write("hash-chain", build_hash_chain())
