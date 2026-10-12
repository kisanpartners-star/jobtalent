import { z } from 'zod';
import { Lead, Job } from '../models/index.js';
import { cleanDeep, randomCode, HttpError } from './helpers.js';
import { notify } from './notify.js';

/* ---------- reusable field schemas ---------- */
const txt = (min = 1, max = 200) => z.string().trim().min(min, 'Required').max(max);
const optTxt = (max = 500) => z.string().trim().max(max).optional().or(z.literal(''));
export const phone = z.string().trim().refine((v) => /^(\+?91[\s-]?)?[6-9]\d{9}$/.test(v.replace(/[\s()-]/g, '')) || /^\+?\d{10,15}$/.test(v.replace(/[\s()-]/g, '')), 'Enter a valid phone number');
export const email = z.string().trim().toLowerCase().email('Enter a valid e-mail address').max(160);
const optEmail = email.optional().or(z.literal(''));
const consent = z.literal(true, { errorMap: () => ({ message: 'Please accept the consent to continue' }) });

/* ---------- enquiry (modal, small forms, contact, service/industry pages) ---------- */
export const enquirySchema = z.object({
  name: txt(2, 100), phone, email: optEmail,
  requirement: txt(3, 1500),
  company: optTxt(150), service: optTxt(120), industry: optTxt(120), city: optTxt(100),
  source: z.enum(['enquiry-modal', 'home-form', 'contact', 'service-page', 'industry-page', 'footer-form', 'job-page', 'website']).default('website'),
  page: optTxt(300), consent,
  website: z.string().max(0).optional(), // honeypot
});

export const chatbotSchema = z.object({
  name: txt(2, 100), phone, requirement: txt(2, 800), topic: optTxt(80), website: z.string().max(0).optional(),
});

/* ---------- multi-step form schemas ---------- */
export const companySchema = z.object({
  companyName: txt(2, 150), contactPerson: txt(2, 100), designation: optTxt(100), phone, email, city: txt(2, 100), industry: txt(2, 120),
  roles: txt(2, 500), headcount: z.coerce.number().int().min(1, 'Enter at least 1').max(100000),
  skillLevel: z.enum(['Unskilled', 'Semi-skilled', 'Skilled', 'Supervisory', 'Managerial']),
  employmentType: z.enum(['Contract', 'Permanent', 'Payroll', 'RPO', 'Facility']),
  startDate: optTxt(40), shift: optTxt(60), location: txt(2, 150), budget: optTxt(100),
  services: z.array(z.string().max(120)).max(20).default([]), currentSetup: optTxt(1000), notes: optTxt(2000),
  consent,
});

export const candidateSchema = z.object({
  name: txt(2, 100), phone, email, dob: optTxt(20), age: z.coerce.number().int().min(16).max(75).optional().or(z.literal('')),
  gender: optTxt(30), city: txt(2, 100),
  roleCategory: txt(2, 150), experience: txt(1, 60), lastEmployer: optTxt(150), noticePeriod: optTxt(60), expectedSalary: optTxt(60),
  preferredLocation: optTxt(150), industries: z.array(z.string().max(120)).max(10).default([]),
  education: txt(2, 200), certifications: optTxt(500), jobSlug: optTxt(120),
  consent,
});

const SCHEMAS = { company: companySchema, candidate: candidateSchema };
export const draftSchemaFor = (kind) => SCHEMAS[kind].partial().extend({ consent: z.boolean().optional() });

/* ---------- mapping form data -> searchable lead fields ---------- */
export function denormalise(kind, d) {
  if (kind === 'company') {
    return { name: d.contactPerson, company: d.companyName, phone: d.phone, email: d.email, city: d.city, industry: d.industry, role: d.roles, service: (d.services || []).join(', '), requirement: d.notes || d.roles };
  }
  return { name: d.name, phone: d.phone, email: d.email, city: d.city, role: d.roleCategory, experience: d.experience, industry: (d.industries || [])[0], requirement: d.education };
}

export const typeLabel = { company: 'Company request', candidate: 'Candidate registration', enquiry: 'Enquiry', chatbot: 'Chatbot lead' };

/* ---------- create simple lead ---------- */
export async function createSimpleLead(type, body, extra = {}) {
  const clean = cleanDeep(body);
  const lead = await Lead.create({
    type, source: clean.source || (type === 'chatbot' ? 'chatbot' : 'website'),
    status: 'New', isDraft: false, submittedAt: new Date(),
    name: clean.name, phone: clean.phone, email: clean.email || undefined, company: clean.company || undefined,
    city: clean.city || undefined, service: clean.service || undefined, industry: clean.industry || undefined,
    requirement: clean.requirement, consent: type === 'chatbot' ? true : clean.consent,
    data: { page: clean.page, topic: clean.topic, ...extra },
    activity: [{ kind: 'created', text: `${typeLabel[type]} received (${clean.source || 'website'})`, by: 'system' }],
  });
  await notify({
    kind: type === 'chatbot' ? 'new_chatbot' : 'new_lead',
    title: type === 'chatbot' ? `New chatbot lead: ${lead.name}` : `New enquiry: ${lead.name}`,
    body: `${lead.phone} - ${lead.requirement || ''}`.slice(0, 300), link: `/admin/leads/${lead._id}`, leadId: lead._id,
  });
  return lead;
}

/* ---------- draft / submit ---------- */
function newCode() { return `VB-${randomCode(6)}`; }

export async function saveDraft(kind, { code, step = 0, data = {}, source = 'register' }, { submit = false } = {}) {
  const cleaned = cleanDeep(data);
  let lead = code ? await Lead.findOne({ resumeCode: String(code).toUpperCase(), type: kind }) : null;
  if (code && !lead) throw new HttpError(404, 'We could not find that resume code.');
  if (lead && !lead.isDraft && !submit) throw new HttpError(409, 'This application has already been submitted.');
  if (lead && !lead.isDraft && submit) throw new HttpError(409, 'This application has already been submitted.');

  const schema = submit ? SCHEMAS[kind] : draftSchemaFor(kind);
  const merged = { ...(lead?.data || {}), ...cleaned };
  const parsed = schema.parse(merged);
  const flat = denormalise(kind, parsed);

  if (!lead) {
    lead = new Lead({ type: kind, source: ['public-form', 'register'].includes(source) ? source : 'register', status: 'Draft', isDraft: true, resumeCode: newCode(), activity: [{ kind: 'draft', text: 'Draft started', by: 'system' }] });
  }
  lead.data = parsed;
  lead.markModified('data');
  Object.entries(flat).forEach(([k, v]) => { if (v !== undefined && v !== '') lead[k] = v; });
  lead.draftStep = Math.max(lead.draftStep || 0, Math.min(Number(step) || 0, 4));
  if (parsed.consent === true) lead.consent = true;

  if (kind === 'candidate' && parsed.jobSlug) {
    const job = await Job.findOne({ slug: parsed.jobSlug }).select('_id title').lean();
    if (job) { lead.jobId = job._id; lead.jobTitle = job.title; }
  }

  if (submit) {
    if (kind === 'candidate' && !(lead.files || []).some((f) => f.field === 'resume')) {
      throw new HttpError(400, 'Please upload your resume before submitting.', { resume: 'Resume is required' });
    }
    lead.isDraft = false; lead.status = 'New'; lead.submittedAt = new Date(); lead.draftStep = 4;
    lead.activity.push({ kind: 'submitted', text: 'Form submitted', by: 'user' });
  }
  await lead.save();

  if (submit) {
    await notify({
      kind: kind === 'candidate' ? 'new_candidate' : 'new_lead',
      title: kind === 'candidate' ? `New candidate registration: ${lead.name}` : `New company request: ${lead.company || lead.name}`,
      body: `${lead.phone} - ${lead.role || ''} (${lead.source})`.slice(0, 300), link: `/admin/leads/${lead._id}`, leadId: lead._id,
    });
  }
  return lead;
}
