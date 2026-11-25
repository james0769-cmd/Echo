"""Export the saved Web workbench minutes to a Word document."""

import io
import json
import math
import sys

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from .minutes import format_ts


def evidence_ranges(item):
    spans = item.get("evidence_spans") or [
        {"start": item.get("evidence_start"), "end": item.get("evidence_end")},
    ]
    valid = []
    for span in spans:
        start, end = span.get("start"), span.get("end")
        if (isinstance(start, (int, float)) and isinstance(end, (int, float))
                and math.isfinite(start) and math.isfinite(end) and 0 <= start <= end):
            valid.append((start, end))
    return "、".join(
        f"{format_ts(start)}–{format_ts(end, round_up=True)}" for start, end in sorted(set(valid))
    )


def set_style(doc, name, size, color, *, before=0, after=0):
    style = doc.styles[name]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style.font.italic = False
    fonts = style.element.get_or_add_rPr().rFonts
    for attr in list(fonts.attrib):
        if attr.lower().endswith("theme"):
            del fonts.attrib[attr]
    fonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    border = style.element.find("w:pPr/w:pBdr", style.element.nsmap)
    if border is not None:
        border.getparent().remove(border)
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.line_spacing = 1.24


def word_text(value, default=""):
    text = str(value or "").strip() or default
    return "".join(char for char in text if char in "\t\n\r" or ord(char) >= 32)


def make_docx(session):
    doc = Document()
    doc.core_properties.title = "会议纪要"
    doc.core_properties.author = "EchoTrace"
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(2.2)
    section.left_margin = section.right_margin = Cm(2.4)
    set_style(doc, "Title", 24, "17233A", after=8)
    set_style(doc, "Subtitle", 10, "475569", after=14)
    set_style(doc, "Heading 1", 15, "17233A", before=14, after=5)
    set_style(doc, "Normal", 10.5, "17233A", after=5)

    doc.add_heading("会议纪要", 0)
    doc.add_paragraph("录音　" + word_text(session.get("audioName"), "未命名录音"), "Subtitle")
    by_topic = {}
    for item in session["minutes"].get("items", []):
        by_topic.setdefault(word_text(item.get("topic"), "其他事项"), []).append(item)
    if not by_topic:
        doc.add_paragraph("这段录音没有生成纪要事项。")

    for topic, items in by_topic.items():
        doc.add_heading(topic, level=1)
        for item in items:
            headline = doc.add_paragraph()
            headline.paragraph_format.keep_with_next = True
            label = " / ".join(filter(None, [word_text(item.get("type")), "已核对" if item.get("verified") else ""]))
            if label:
                headline.add_run(f"〔{label}〕 ").bold = True
            headline.add_run(word_text(item.get("content")))
            fields = [
                "负责人　" + word_text(item.get("responsible"), "未知"),
                "截止　" + word_text(item.get("deadline"), "未知"),
            ]
            metadata = doc.add_paragraph("　|　".join(fields))
            metadata.paragraph_format.keep_with_next = True
            ranges = doc.add_paragraph()
            ranges.add_run("证据时间　").bold = True
            ranges.add_run(evidence_ranges(item) or "未找到可定位的时间段")
            quote = word_text(item.get("evidence_text"))
            if quote:
                ranges.paragraph_format.keep_with_next = True
                doc.add_paragraph("原话　" + quote)

    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


if __name__ == "__main__":
    session = json.loads(sys.stdin.buffer.read())
    sys.stdout.buffer.write(make_docx(session))
