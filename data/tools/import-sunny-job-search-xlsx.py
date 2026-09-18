#!/usr/bin/env python3
"""One-time local import of exported Sunny daily Google Sheet tabs."""
import json, re, sys
from datetime import date
from pathlib import Path
import openpyxl

HEADERS = ['優先序','推薦分數','建議','公司','職缺','分類','地點','工作模式','發布日期','主要缺口','使用履歷','申請連結','LinkedIn People','內推訊息']
LINK = re.compile(r'=HYPERLINK\("((?:[^"]|"")*)","((?:[^"]|"")*)"\)')

def link(value):
    match = LINK.fullmatch(str(value or ''))
    if match: return match.group(1).replace('""','"'), match.group(2).replace('""','"')
    return str(value or ''), str(value or '')

def priority(label, score):
    if '低優先' in label or '較低優先' in label: return 'low', '低優先'
    if '立即投遞' in label or '優先投遞' in label: return 'priority', '優先投遞'
    if '建議投遞' in label: return 'suggested', '建議投遞'
    return ('priority','優先投遞') if score >= 85 else (('suggested','建議投遞') if score >= 75 else ('low','低優先'))

def text(value): return '' if value is None else str(value)

def referral_message(value):
    return re.sub(r'Email:\s*yiyunliao[^@\s]*@gmail\.com', 'Email: yiyunliao21@gmail.com', text(value))

def main(source, target):
    workbook = openpyxl.load_workbook(source, data_only=False, read_only=True)
    jobs = []
    for sheet in workbook.worksheets:
        try: date.fromisoformat(sheet.title)
        except ValueError: continue
        rows = sheet.iter_rows(values_only=True)
        header = None
        for row in rows:
            values = list(row[:14])
            if values == HEADERS: header = True; continue
            if not header or not any(values): continue
            if not isinstance(values[0], (int, float)) or not isinstance(values[1], (int, float)): continue
            recommendation_url, recommendation = link(values[2])
            apply_url, _ = link(values[11])
            linkedin_url, _ = link(values[12])
            if not apply_url.startswith(('http://','https://')): continue
            key, label = priority(recommendation, float(values[1]))
            jobs.append({'id': apply_url, 'scanDate': sheet.title, 'priority': key, 'priorityLabel': label, 'score': float(values[1]), 'recommendation': recommendation, 'recommendationUrl': recommendation_url if recommendation_url.startswith('http') else '', 'company': text(values[3]), 'title': text(values[4]), 'category': text(values[5]), 'location': text(values[6]), 'workMode': text(values[7]), 'postedDate': text(values[8]), 'primaryGap': text(values[9]), 'resume': text(values[10]), 'applyUrl': apply_url, 'linkedinPeopleUrl': linkedin_url if linkedin_url.startswith('http') else '', 'referralMessage': referral_message(values[13])})
    payload = {'schemaVersion': 1, 'timeZone': 'America/New_York', 'jobs': jobs}
    Path(target).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(jobs)} suitable rows from {min(j["scanDate"] for j in jobs)} to {max(j["scanDate"] for j in jobs)}.')

if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
