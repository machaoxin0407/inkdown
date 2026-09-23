"""Inspect the native PDF regression outputs (pypdf + pypdfium2 + Pillow)."""
import json
import re
from pathlib import Path
from pypdf import PdfReader
import pypdfium2

report = json.loads(Path('artifacts/pdf-report.json').read_text(encoding='utf-8'))
for key in ['output', 'edited']:
    reader = PdfReader(report[key])
    text = re.sub(r'\s+', '', '\n'.join(page.extract_text() for page in reader.pages))
    expected = ['PDF导出验证', '开始阅读', '导出文档', 'Localimage/PDF', '第20节'] if key == 'output' else ['未保存编辑', '导出当前内容']
    for value in expected:
        assert value in text, f'Missing text: {value}'
    assert '复制' not in text, 'Copy button leaked into PDF'
    assert 594 < float(reader.pages[0].mediabox.width) < 596
    assert 841 < float(reader.pages[0].mediabox.height) < 843
    document = pypdfium2.PdfDocument(report[key])
    for number in range(len(document)):
        page = document[number]
        bitmap = page.render(scale=1.4)
        image = bitmap.to_pil().convert('RGB')
        assert min(image.getpixel((5, 5))) > 245, 'Page margin is not white'
        image.save(f'artifacts/pdf-{key}-{number+1}.png')
        bitmap.close()
        page.close()
    document.close()
    print(f'PASS {key}: {len(reader.pages)} A4 pages, selectable text and white paper')
