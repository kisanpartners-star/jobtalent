import ExcelJS from 'exceljs';

const NAVY = 'FF10294C';
const GOLD = 'FFC99D41';

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * sheets: [{ name, columns: [{ header, key, width }], rows: [] }]
 * format: 'xlsx' | 'csv' (csv uses the first sheet)
 */
export async function sendExport(res, { filename, sheets, format = 'xlsx' }) {
  const safe = filename.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (format === 'csv') {
    const s = sheets[0];
    const lines = [s.columns.map((c) => csvCell(c.header)).join(',')];
    for (const r of s.rows) lines.push(s.columns.map((c) => csvCell(r[c.key])).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safe}.csv"` });
    return res.send('﻿' + lines.join('\r\n'));
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VB TALENTX'; wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    head.alignment = { vertical: 'middle' }; head.height = 22;
    for (const r of s.rows) {
      const row = {};
      for (const c of s.columns) { const v = r[c.key]; row[c.key] = typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v; }
      ws.addRow(row);
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
    ws.getRow(1).border = { bottom: { style: 'medium', color: { argb: GOLD } } };
  }
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${safe}.xlsx"` });
  await wb.xlsx.write(res);
  res.end();
}

export const LEAD_COLUMNS = [
  { header: 'Created', key: 'createdAt', width: 20 }, { header: 'Type', key: 'type', width: 12 }, { header: 'Source', key: 'source', width: 14 },
  { header: 'Status', key: 'status', width: 18 }, { header: 'Name', key: 'name', width: 22 }, { header: 'Company', key: 'company', width: 24 },
  { header: 'Phone', key: 'phone', width: 16 }, { header: 'Email', key: 'email', width: 28 }, { header: 'City', key: 'city', width: 14 },
  { header: 'Role', key: 'role', width: 26 }, { header: 'Industry', key: 'industry', width: 20 }, { header: 'Service', key: 'service', width: 26 },
  { header: 'Experience', key: 'experience', width: 14 }, { header: 'Requirement / Notes', key: 'requirement', width: 40 },
  { header: 'Next follow-up', key: 'nextFollowUpAt', width: 20 }, { header: 'Assigned to', key: 'assignedName', width: 18 },
  { header: 'Draft step', key: 'draftStep', width: 10 }, { header: 'Resume code', key: 'resumeCode', width: 14 }, { header: 'Reject reason', key: 'rejectReason', width: 24 },
];

export function leadRow(l, assignee) {
  return {
    createdAt: l.createdAt, type: l.type, source: l.source, status: l.isDraft ? 'Draft' : l.status, name: l.name, company: l.company, phone: l.phone, email: l.email,
    city: l.city, role: l.role, industry: l.industry, service: l.service, experience: l.experience, requirement: l.requirement, nextFollowUpAt: l.nextFollowUpAt,
    assignedName: assignee || '', draftStep: l.isDraft ? l.draftStep : '', resumeCode: l.resumeCode, rejectReason: l.rejectReason,
  };
}
