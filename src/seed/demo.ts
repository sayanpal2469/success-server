/**
 * Demo data shaped like the admin panel's mock data, with dates relative to today: students in every
 * class (with payments), admission requests, routine, exams with results, mock attempts, attendance
 * registers, feedback, notices, banners, website content, free classes and courses.
 * Every demo student's app password is 1234; Ananya Sharma is ST26-0142.
 */
import type { Types } from 'mongoose';

import { hashPassword } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { addDays, addMonthsInclusive, financialYear, istInstant, monthsBetween, todayIST, weekday } from '../lib/time.js';
import { youtubeId } from '../lib/youtube.js';
import { Banner, Course, FreeVideo, Notice, Ranker, Teacher } from '../models/content.js';
import { Counter, Settings } from '../models/org.js';
import { Attendance, RoutineChange, Slot } from '../models/schedule.js';
import { Application, Feedback, Payment, Student, type StudentDoc } from '../models/students.js';
import { Attempt, Exam, ExamSubmission, MockTest, type QuestionDoc } from '../models/tests.js';
import { loadCatalog } from '../services/catalog.js';
import { feeOf, monthAmount } from '../services/fees.js';
import { score } from '../services/tests.js';

/* ───────────────────────── Deterministic randomness ───────────────────────── */

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: readonly T[]) => arr[Math.floor(r() * arr.length)]!;
const between = (r: () => number, a: number, b: number) => Math.floor(a + r() * (b - a + 1));

const firstM = ['Arnab', 'Rohan', 'Sayan', 'Aritra', 'Debojit', 'Soumik', 'Ankit', 'Rahul', 'Subhajit', 'Pritam', 'Abhishek', 'Sourav', 'Tanmoy', 'Ayan', 'Kaustav', 'Rajdeep', 'Ishaan', 'Niladri', 'Shubham', 'Arijit'];
const firstF = ['Ananya', 'Priyanka', 'Sreeja', 'Moumita', 'Riya', 'Debasmita', 'Ankita', 'Sohini', 'Tanisha', 'Shreya', 'Puja', 'Rimpa', 'Swastika', 'Aishani', 'Madhurima', 'Payel', 'Trisha', 'Oishi', 'Srijani', 'Ritika'];
const mothers = ['Sharmila', 'Mitali', 'Rina', 'Sutapa', 'Kakali', 'Mousumi', 'Soma', 'Tanushree', 'Jayashree', 'Anindita'];
const surnames = ['Sharma', 'Das', 'Ghosh', 'Mondal', 'Saha', 'Roy', 'Banerjee', 'Chatterjee', 'Mukherjee', 'Paul', 'Dey', 'Sen', 'Biswas', 'Majumder', 'Bose', 'Sarkar', 'Halder', 'Nandi', 'Kar', 'Pal'];
const schools = ['Howrah Zilla School', 'Shibpur Dinobundhoo Institution', 'Santragachi Kedarnath Institution', 'Delhi Public School Howrah', 'Kendriya Vidyalaya Santragachi', 'Salkia A.S. High School', 'Bally Banga Shishu Vidyalaya'];
const colleges = ['Narasinha Dutt College', 'Howrah Vivekananda Institution', 'Bijoy Krishna Girls’ College', 'IIEST Shibpur', 'Bally Jagachha College'];
const teachers = ['Srijit Saha', 'Anirban Ghosh', 'Ranjan Dey', 'Mitali Sen', 'Debashis Paul'];
const photos = [
  'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=240&q=70',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=240&q=70',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=240&q=70',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&q=70',
];

const phone = (r: () => number) => `+91${pick(r, ['98', '97', '90', '83', '70', '62', '91'])}${between(r, 10000000, 99999999)}`;
const aadhaar = (r: () => number) => `${between(r, 2000, 9999)}${between(r, 1000, 9999)}${between(r, 1000, 9999)}`;

/* ───────────────────────── Question bank ───────────────────────── */

type Q = { q: string; options: string[]; answer: number; explanation?: string };
const bank: Record<string, Q[]> = {
  Mathematics: [
    { q: 'What is 15% of 240?', options: ['24', '36', '32', '30'], answer: 1, explanation: '240 × 15 / 100 = 36' },
    { q: 'The value of (a + b)² − (a − b)² is', options: ['2ab', '4ab', 'a² + b²', '0'], answer: 1 },
    { q: 'Sum of the interior angles of a hexagon is', options: ['540°', '720°', '900°', '360°'], answer: 1 },
    { q: 'If 3x − 7 = 11, then x =', options: ['4', '5', '6', '7'], answer: 2 },
    { q: 'HCF of 36 and 48 is', options: ['6', '12', '18', '24'], answer: 1 },
    { q: 'Area of a circle with radius 7 cm (π = 22/7) is', options: ['144 cm²', '154 cm²', '164 cm²', '44 cm²'], answer: 1 },
  ],
  Science: [
    { q: 'The SI unit of force is', options: ['Joule', 'Newton', 'Watt', 'Pascal'], answer: 1 },
    { q: 'Which gas do plants absorb during photosynthesis?', options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], answer: 2 },
    { q: 'The chemical formula of common salt is', options: ['KCl', 'NaCl', 'NaOH', 'CaCO₃'], answer: 1 },
    { q: 'Which organ purifies blood in the human body?', options: ['Heart', 'Lungs', 'Kidney', 'Liver'], answer: 2 },
    { q: 'Speed of light in vacuum is about', options: ['3 × 10⁶ m/s', '3 × 10⁸ m/s', '3 × 10⁵ m/s', '3 × 10¹⁰ m/s'], answer: 1 },
  ],
  Physics: [
    { q: 'Dimensional formula of Planck’s constant is', options: ['[ML²T⁻¹]', '[MLT⁻¹]', '[ML²T⁻²]', '[M⁰L⁰T⁰]'], answer: 0 },
    { q: 'A body thrown up at 20 m/s (g = 10 m/s²) reaches a maximum height of', options: ['10 m', '20 m', '40 m', '80 m'], answer: 1 },
    { q: 'Unit of electric potential is', options: ['Ampere', 'Volt', 'Ohm', 'Coulomb'], answer: 1 },
    { q: 'Focal length of a plane mirror is', options: ['Zero', 'Infinite', '25 cm', 'Depends on size'], answer: 1 },
    { q: 'Work done by a centripetal force in uniform circular motion is', options: ['Positive', 'Negative', 'Zero', 'Maximum'], answer: 2 },
  ],
  Chemistry: [
    { q: 'Number of moles in 64 g of O₂ is', options: ['1', '2', '4', '0.5'], answer: 1 },
    { q: 'Hybridisation of carbon in methane is', options: ['sp', 'sp²', 'sp³', 'dsp²'], answer: 2 },
    { q: 'pH of pure water at 25 °C is', options: ['0', '7', '14', '1'], answer: 1 },
    { q: 'Which is an alkali metal?', options: ['Calcium', 'Sodium', 'Iron', 'Zinc'], answer: 1 },
  ],
  English: [
    { q: 'Choose the correct spelling', options: ['Accomodate', 'Accommodate', 'Acommodate', 'Acomodate'], answer: 1 },
    { q: 'Synonym of “rapid”', options: ['Slow', 'Quick', 'Late', 'Weak'], answer: 1 },
    { q: 'She ___ to school every day.', options: ['go', 'goes', 'going', 'gone'], answer: 1 },
    { q: 'Antonym of “ancient”', options: ['Old', 'Modern', 'Past', 'Aged'], answer: 1 },
  ],
};
const WRITTEN_INSTRUCTIONS = '<p>Answer all questions in your notebook. Write the question number clearly. Figures in the margin show full marks.</p><p>After the exam, upload clear photos of your answers in the app (as one PDF), or hand in your notebook at the centre.</p>';

/** A written paper: short, long and very long answers in three groups. */
const WRITTEN: Record<string, [string, string, number][]> = {
  Mathematics: [
    ['Group A', '<p>Solve: 3x − 7 = 2x + 5.</p>', 2],
    ['Group A', '<p>Find the HCF and LCM of 36 and 48 by prime factorisation.</p>', 3],
    ['Group B', '<p>Prove that the sum of the interior angles of a triangle is 180°.</p>', 5],
    ['Group B', '<p>A shopkeeper sells an article at a profit of 12%. If the cost price is ₹2,500, find the selling price. Show all steps.</p>', 5],
    ['Group C', '<p>Solve the quadratic equation x² − 5x + 6 = 0 by factorisation and verify both roots.</p>', 8],
    ['Group C', '<p>The angle of elevation of the top of a tower from a point 40 m away is 60°. Find the height of the tower (√3 = 1.732). Draw the figure.</p>', 7],
  ],
  Physics: [
    ['Group A', '<p>State Newton’s second law of motion.</p>', 2],
    ['Group A', '<p>Define the SI unit of electric potential.</p>', 2],
    ['Group B', '<p>Derive the equation v² = u² + 2as for uniformly accelerated motion.</p>', 6],
    ['Group B', '<p>Explain the working of a step-up transformer with a labelled diagram.</p>', 6],
    ['Group C', '<p>State Ohm’s law. Describe an experiment to verify it, with the circuit diagram, observation table and graph.</p>', 9],
  ],
  English: [
    ['Group A', '<p>Write the meanings of: (a) rapid (b) ancient (c) accommodate.</p>', 3],
    ['Group B', '<p>Read the passage given by your teacher and answer the questions in your own words.</p>', 10],
    ['Group C', '<p>Write a letter to your friend describing your school’s annual sports day (about 150 words).</p>', 10],
    ['Group C', '<p>Write a paragraph on “The importance of reading books” (about 120 words).</p>', 7],
  ],
  Science: [
    ['Group A', '<p>What is photosynthesis? Write its balanced equation.</p>', 3],
    ['Group B', '<p>Describe the structure of the human heart with a labelled diagram.</p>', 7],
    ['Group C', '<p>Explain the difference between physical and chemical changes with three examples each.</p>', 10],
  ],
};
const writtenFor = (subject: string) =>
  (WRITTEN[subject] ?? WRITTEN[subject.includes('Science') ? 'Science' : 'Mathematics']!).map(([section, text, marks]) => ({ section, text, marks }));

const qFor = (subject: string, n: number) => {
  const pool = bank[subject] ?? bank[subject.includes('Science') ? 'Science' : 'Mathematics']!;
  return Array.from({ length: n }, (_, i) => ({ ...pool[i % pool.length]!, q: i < pool.length ? pool[i]!.q : `${pool[i % pool.length]!.q} (Q${i + 1})` }));
};

/** Answers a student of this ability would give: mostly right, some wrong, a few skipped. */
function answersFor(r: () => number, questions: QuestionDoc[], ability: number) {
  const m = new Map<string, number>();
  for (const q of questions) {
    const x = r();
    if (x < ability * 0.95) m.set(String(q._id), q.answer);
    else if (x < 0.93) m.set(String(q._id), (q.answer + 1 + Math.floor(r() * 3)) % 4);
  }
  return m;
}

/* ───────────────────────── Build ───────────────────────── */

export async function seedDemo() {
  if (await Student.exists({})) {
    logger.warn('students already exist — demo data skipped (run with --reset to wipe and reload)');
    return;
  }
  const today = todayIST();
  const cat = await loadCatalog();
  const classes = [...cat.classes.values()];
  const extras = [...cat.extras.values()];
  const settings = await Settings.findById('main');
  const dueDay = settings?.dueDay ?? 10;
  const pw = await hashPassword('1234');
  const ability = new Map<string, number>();

  /* Students */
  const r = rng(42);
  const perClass = [10, 11, 12, 13, 15, 18, 14, 16, 6, 5, 4, 4];
  const docs: Record<string, unknown>[] = [];
  let n = 0;
  classes.forEach((c, ci) => {
    for (let k = 0; k < (perClass[ci] ?? 4); k++) {
      const demo = n === 0;
      const cls = demo ? cat.classes.get('c10')! : c;
      const female = demo || r() < 0.48;
      const surname = demo ? 'Sharma' : pick(r, surnames);
      const name = demo ? 'Ananya Sharma' : `${pick(r, female ? firstF : firstM)} ${surname}`;
      const admissionDate = demo ? `${today.slice(0, 4)}-04-06` : addDays(today, -between(r, 40, 220));
      const college = cls.group === 'College';
      const durationMonths = college ? 6 : 12;
      const age = 10 + classes.indexOf(cls);
      const subjectIds = demo ? ['c10-bengali', 'c10-english', 'c10-mathematics', 'c10-physical-science'] : cls.subjects.filter((_, i) => i < 2 || r() < 0.6).map((s) => s._id);
      const ex = demo ? ['spoken'] : extras.filter(() => r() < 0.18).map((e) => e._id);
      const discount = !demo && r() < 0.08 ? 100 : 0;
      // 0142 belongs to Ananya, so the others skip it.
      const studentId = demo ? 'ST26-0142' : `ST26-${String(101 + n >= 142 ? 102 + n : 101 + n).padStart(4, '0')}`;
      docs.push({
        studentId,
        name,
        classId: cls._id,
        batch: demo ? 'Morning' : pick(r, cls.batches),
        phone: demo ? '+919830041526' : phone(r),
        gender: female ? 'Female' : 'Male',
        dob: demo ? '2011-03-14' : `${Number(today.slice(0, 4)) - age}-${String(between(r, 1, 12)).padStart(2, '0')}-${String(between(r, 1, 28)).padStart(2, '0')}`,
        photo: n < 4 ? photos[n] : undefined,
        email: demo ? 'ananya.sharma0@gmail.com' : r() < 0.6 ? `${name.split(' ')[0]!.toLowerCase()}.${surname.toLowerCase()}${n}@gmail.com` : undefined,
        aadhaar: demo ? '482148214821' : aadhaar(r),
        fatherName: demo ? 'Rohan Sharma' : `${pick(r, firstM)} ${surname}`,
        motherName: demo ? 'Sutapa Sharma' : `${pick(r, mothers)} ${surname}`,
        guardianPhone: demo ? '+919748133102' : phone(r),
        school: demo ? 'Delhi Public School Howrah' : college ? pick(r, colleges) : pick(r, schools),
        board: demo ? 'CBSE' : college ? 'University' : ['c11', 'c12'].includes(cls._id) ? pick(r, ['WBCHSE', 'CBSE', 'ISC']) : pick(r, ['WBBSE', 'CBSE', 'ICSE']),
        targetExams: demo ? ['Board exams'] : college ? ['University exams'] : ['c11', 'c12'].includes(cls._id) ? ['Higher Secondary', pick(r, ['WBJEE', 'JEE Main', 'NEET'])] : ['c9', 'c10'].includes(cls._id) ? ['Madhyamik'] : ['Board exams'],
        subjectIds,
        extras: ex,
        admissionDate,
        durationMonths,
        validTill: addMonthsInclusive(admissionDate, durationMonths),
        idIssued: addDays(admissionDate, 1),
        discount,
        discountReason: discount ? 'Sibling discount' : undefined,
        status: demo || r() < 0.94 ? 'ACTIVE' : 'INACTIVE',
        passwordHash: pw,
      });
      ability.set(studentId, demo ? 0.86 : 0.35 + r() * 0.6);
      n++;
    }
  });
  const students = (await Student.insertMany(docs)) as unknown as (StudentDoc & { _id: Types.ObjectId })[];
  const abilityOf = (s: StudentDoc) => ability.get(s.studentId) ?? 0.6;
  logger.info({ students: students.length }, 'students');

  /* Payments: paid up to now except 0–2 recent months (Ananya owes this month) */
  const pr = rng(77);
  const payRows: Record<string, unknown>[] = [];
  for (const s of students) {
    const last = s.validTill < today ? s.validTill : today;
    const months = monthsBetween(s.admissionDate, last);
    const unpaid = s.studentId === 'ST26-0142' ? 1 : pr() < 0.55 ? 0 : pr() < 0.7 ? 1 : 2;
    for (const m of months.slice(0, Math.max(1, months.length - unpaid))) {
      // This month's payments fall between the 1st and today; earlier months around the due day.
      const thisMonth = m === today.slice(0, 7);
      const day = `${m}-${String(thisMonth ? between(pr, 1, Number(today.slice(8))) : between(pr, 3, 12)).padStart(2, '0')}`;
      payRows.push({ student: s._id, months: [m], amount: monthAmount(s, cat, m), method: pick(pr, ['Cash', 'Cash', 'Cash', 'UPI', 'UPI', 'Bank transfer'] as const), receivedAt: istInstant(day < today ? day : today, `${between(pr, 9, 19)}:20`.padStart(5, '0')), receivedBy: 'Srijit Saha', _day: day < today ? day : today });
    }
  }
  payRows.sort((a, b) => String(a._day).localeCompare(String(b._day)));
  const seqByFy = new Map<string, number>();
  for (const p of payRows) {
    const fy = financialYear(String(p._day));
    const next = (seqByFy.get(fy) ?? 0) + 1;
    seqByFy.set(fy, next);
    p.receiptNo = `ST/${fy}/${String(next).padStart(5, '0')}`;
    delete p._day;
  }
  await Payment.insertMany(payRows);
  for (const [fy, seq] of seqByFy) await Counter.updateOne({ _id: `receipt:${fy}` }, { $set: { seq } }, { upsert: true });
  logger.info({ payments: payRows.length }, 'payments');

  /* Admission requests from the app */
  const ar = rng(808);
  const reqs: [string, 'Male' | 'Female', string, number, 'PENDING' | 'REJECTED'][] = [
    ['Ritika Bose', 'Female', 'c12', 0, 'PENDING'],
    ['Arijit Sarkar', 'Male', 'c10', 0, 'PENDING'],
    ['Oishi Nandi', 'Female', 'c11', 1, 'PENDING'],
    ['Kaustav Halder', 'Male', 'c8', 1, 'PENDING'],
    ['Payel Kar', 'Female', 'c6', 2, 'PENDING'],
    ['Niladri Sen', 'Male', 'y1', 3, 'PENDING'],
    ['Soumik Paul', 'Male', 'c12', 12, 'REJECTED'],
  ];
  const yy = today.slice(2, 4);
  await Application.insertMany(
    reqs.map(([name, gender, classId, ago, status], i) => {
      const cls = cat.classes.get(classId)!;
      const surname = name.split(' ')[1]!;
      const at = istInstant(addDays(today, -ago), `${10 + i}:15`);
      return {
        ref: `REQ-${yy}-${String(i + 1).padStart(4, '0')}`,
        name,
        gender,
        classId,
        phone: phone(ar),
        dob: `${classId.startsWith('y') ? 2007 : 2015 - classes.indexOf(cls)}-0${(i % 9) + 1}-1${i}`,
        photo: photos[i % photos.length],
        email: i % 3 ? `${name.split(' ')[0]!.toLowerCase()}${i}@gmail.com` : undefined,
        aadhaar: aadhaar(ar),
        fatherName: `${firstM[i]} ${surname}`,
        motherName: `${mothers[i]} ${surname}`,
        guardianPhone: phone(ar),
        school: cls.group === 'College' ? colleges[i % colleges.length] : schools[i % schools.length],
        board: cls.group === 'College' ? 'University' : i % 2 ? 'CBSE' : 'WBBSE',
        targetExams: ['c11', 'c12'].includes(classId) ? ['Higher Secondary', 'WBJEE'] : ['c9', 'c10'].includes(classId) ? ['Madhyamik'] : ['Board exams'],
        subjectIds: cls.subjects.filter((_, k) => k < 3 || ar() < 0.4).map((s) => s._id),
        extras: i % 3 === 0 ? ['spoken'] : i === 4 ? ['drawing'] : [],
        status,
        rejectReason: status === 'REJECTED' ? 'Batch full — asked to apply for the next session' : undefined,
        reviewedAt: status === 'REJECTED' ? at : undefined,
        passwordHash: pw,
        createdAt: at,
        updatedAt: at,
      };
    }),
  );
  await Counter.updateOne({ _id: `application:${yy}` }, { $set: { seq: reqs.length } }, { upsert: true });

  /* Weekly routine */
  const slots: Record<string, unknown>[] = [];
  const times = [
    ['16:00', '17:00'],
    ['17:10', '18:10'],
    ['18:20', '19:20'],
  ];
  const collegeTimes = [
    ['10:00', '11:00'],
    ['11:10', '12:10'],
    ['12:20', '13:20'],
  ];
  classes.forEach((c, ci) => {
    const college = c.group === 'College';
    const days = college ? [5, 6] : ci % 2 ? [1, 3, 5] : [0, 2, 4];
    let k = 0;
    days.forEach((day) =>
      (college ? collegeTimes : times.slice(0, 2)).forEach(([start, end]) => {
        const s = c.subjects[k++ % c.subjects.length]!;
        slots.push({ groupId: c._id, day, start, end, subject: s.name, teacher: teachers[(ci + k) % teachers.length], room: `Room ${(ci % 4) + 1}` });
      }),
    );
  });
  slots.push(
    { groupId: 'drawing', day: 5, start: '10:00', end: '11:30', subject: 'Drawing', teacher: 'Payel Kar', room: 'Art room' },
    { groupId: 'drawing', day: 6, start: '10:00', end: '11:30', subject: 'Drawing', teacher: 'Payel Kar', room: 'Art room' },
    { groupId: 'spoken', day: 1, start: '19:30', end: '20:30', subject: 'Spoken English', teacher: 'Ritika Bose', room: 'Room 1' },
    { groupId: 'spoken', day: 3, start: '19:30', end: '20:30', subject: 'Spoken English', teacher: 'Ritika Bose', room: 'Room 1' },
    { groupId: 'competitive', day: 5, start: '15:00', end: '17:00', subject: 'Physics + Maths practice', teacher: 'Srijit Saha', room: 'Hall' },
    { groupId: 'competitive', day: 6, start: '15:00', end: '18:00', subject: 'Weekly mock test', teacher: 'Srijit Saha', room: 'Hall' },
  );
  const slotDocs = await Slot.insertMany(slots);
  // One postponed Class 10 class later this week, one cancelled Spoken English class.
  const c10Slot = slotDocs.find((s) => s.groupId === 'c10')!;
  let d = addDays(today, 1);
  while (weekday(d) !== c10Slot.day) d = addDays(d, 1);
  const n1 = await Notice.create({ title: `Class postponed — ${c10Slot.subject} (Class 10)`, body: `The class on ${d} at ${c10Slot.start} moves to ${addDays(d, 1)} at 17:10. Teacher on leave.`, audience: 'Class', target: 'c10', kind: 'ROUTINE', by: 'Srijit Saha', expires: addDays(d, 1) });
  await RoutineChange.create({ slot: c10Slot._id as Types.ObjectId, groupId: 'c10', date: d, kind: 'POSTPONED', newDate: addDays(d, 1), newStart: '17:10', newEnd: '18:10', reason: 'Teacher on leave', notice: n1._id });
  const sp = slotDocs.find((s) => s.groupId === 'spoken')!;
  let d2 = addDays(today, -1);
  while (weekday(d2) !== sp.day) d2 = addDays(d2, -1);
  await RoutineChange.create({ slot: sp._id as Types.ObjectId, groupId: 'spoken', date: d2, kind: 'CANCELLED', reason: 'Power cut in the building' });

  /* Attendance registers for the last 8 weeks (Ananya ~90 %) */
  const att = rng(5150);
  const regs: Record<string, unknown>[] = [];
  const active = students.filter((s) => s.status === 'ACTIVE');
  const groups = [...classes.map((c) => c._id), ...extras.map((e) => e._id)];
  for (const g of groups) {
    const days = new Set(slotDocs.filter((s) => s.groupId === g).map((s) => s.day));
    const members = active.filter((s) => (cat.classes.has(g) ? s.classId === g : s.extras.includes(g)));
    if (!members.length) continue;
    for (let day = addDays(today, -56); day < today; day = addDays(day, 1)) {
      if (!days.has(weekday(day)) || (g === 'spoken' && day === d2)) continue;
      const roll = members.filter((s) => s.admissionDate <= day);
      if (!roll.length) continue;
      regs.push({ groupId: g, date: day, batch: '', takenBy: 'Srijit Saha', marks: roll.map((s) => ({ student: s._id, mark: att() < 0.62 + abilityOf(s) * 0.36 ? 'P' : 'A' })) });
    }
  }
  await Attendance.insertMany(regs);
  logger.info({ registers: regs.length }, 'attendance');

  /* Written exams with answer sheets and marks */
  const examDefs = [
    { title: '1st Unit Test — Mathematics', classId: 'c10', subject: 'Mathematics', ago: 9, start: '17:00', duration: 90, publish: true },
    { title: '1st Unit Test — Physics', classId: 'c12', subject: 'Physics', ago: 6, start: '18:00', duration: 90, publish: true },
    { title: 'Weekly test — Science', classId: 'c8', subject: 'Science', ago: 1, start: '16:30', duration: 60, publish: false },
    { title: '1st Unit Test — English', classId: 'c6', subject: 'English', ago: 14, start: '16:00', duration: 60, publish: true },
    { title: 'Mid-semester test — Mathematics', classId: 'y1', subject: 'Mathematics', ago: 20, start: '11:00', duration: 120, publish: true },
    { title: '1st Unit Test — English', classId: 'c10', subject: 'English', ago: 23, start: '17:00', duration: 90, publish: true },
    { title: 'Half-yearly — Physics', classId: 'c12', subject: 'Physics', ago: -4, start: '10:00', duration: 180, publish: false },
    { title: '2nd Unit Test — Mathematics', classId: 'c9', subject: 'Mathematics', ago: -2, start: '17:00', duration: 90, publish: false },
    { title: '2nd Unit Test — Physical Science', classId: 'c10', subject: 'Physical Science', ago: -3, start: '17:00', duration: 90, publish: false },
  ];
  const er = rng(1234);
  const attempts: Record<string, unknown>[] = [];
  const sheets: Record<string, unknown>[] = [];
  const feedbacks: Record<string, unknown>[] = [];
  for (const x of examDefs) {
    const date = addDays(today, -x.ago);
    const e = await Exam.create({ title: x.title, classId: x.classId, subject: x.subject, date, start: x.start, duration: x.duration, questions: writtenFor(x.subject), instructions: WRITTEN_INSTRUCTIONS, uploadMinutes: 180 });
    if (x.ago <= 0) continue;
    const pool = active.filter((s) => s.classId === x.classId && cat.classes.get(s.classId)!.subjects.some((sub) => s.subjectIds.includes(sub._id) && sub.name === x.subject));
    const rows: { s: StudentDoc & { _id: Types.ObjectId }; score: number }[] = [];
    for (const s of pool) {
      const r = er();
      if (r > (s.studentId === 'ST26-0142' ? 1 : 0.92)) continue;
      const upload = er() < 0.6;
      const submittedAt = new Date(e.endsAt.getTime() + between(er, -20, 90) * 60_000);
      const sheet: Record<string, unknown> = { exam: e._id, student: s._id, mode: upload ? 'UPLOAD' : 'MANUAL', by: upload || er() < 0.5 ? 'STUDENT' : 'OFFICE', submittedAt, late: submittedAt > e.endsAt, pages: upload ? between(er, 3, 9) : undefined };
      // Older exams are checked; the latest unpublished one still waits for marks.
      if (x.publish || er() < 0.4) {
        const marks: Record<string, number> = {};
        for (const q of e.questions) marks[String(q._id)] = Math.min(q.marks, Math.max(0, Math.round(q.marks * (abilityOf(s) * 0.85 + er() * 0.3) * 2) / 2));
        const total = Object.values(marks).reduce((a, m) => a + m, 0);
        Object.assign(sheet, { status: 'CHECKED', marks, total, checkedAt: istInstant(addDays(date, 1), '19:00'), checkedBy: 'Srijit Saha' });
        rows.push({ s, score: total });
      }
      sheets.push(sheet);
    }
    if (x.publish) {
      e.resultsPublished = true;
      e.publishedAt = istInstant(addDays(date, 2), '20:00');
      const top = rows.sort((a, b) => b.score - a.score)[0];
      if (top) {
        const notice = await Notice.create({
          title: `Topper — ${x.title} (${cat.classes.get(x.classId)!.name})`,
          body: `Congratulations ${top.s.name} for topping ${x.title} with ${top.score}/${e.fullMarks}!`,
          audience: 'All students',
          kind: 'TOPPER',
          pinned: true,
          by: 'Srijit Saha',
          publishAt: istInstant(addDays(date, 3)),
          expires: addDays(date, 3),
        });
        e.topperNotice = notice._id;
      }
      await e.save();
      rows.slice(0, 3).forEach((row, i) =>
        feedbacks.push({ student: row.s._id, exam: e._id, text: ['Excellent answers — well presented and complete.', 'Good work — write the steps more clearly.', 'Strong concepts. Practise long answers within the time.'][i], by: 'Srijit Saha', at: istInstant(addDays(date, 2), '21:00') }),
      );
    }
  }
  await ExamSubmission.insertMany(sheets);
  await Attempt.insertMany(attempts);
  const ananya = students.find((s) => s.studentId === 'ST26-0142')!;
  feedbacks.push({ student: ananya._id, text: 'Very attentive in class and asks good questions. Keep it up!', by: 'Srijit Saha', at: istInstant(addDays(today, -21), '18:00') });
  await Feedback.insertMany(feedbacks);
  logger.info({ exams: examDefs.length, attempts: attempts.length }, 'exams');

  /* Mock tests with attempts */
  const mockDefs = [
    { title: 'Mathematics practice set 1', classId: 'c10', subject: 'Mathematics', n: 20, duration: 30, marksPerQ: 1, negative: 0, openFrom: addDays(today, -20), attemptsAllowed: 0, showAnswers: true, published: true, instructions: 'Practise as many times as you like.' },
    { title: 'Physics full mock', classId: 'c12', subject: 'Physics', n: 45, duration: 180, marksPerQ: 4, negative: 1, openFrom: addDays(today, -10), openTill: addDays(today, 20), attemptsAllowed: 2, showAnswers: true, published: true, instructions: '+4 / −1. Two attempts.' },
    { title: 'Science quick mock', classId: 'c8', subject: 'Science', n: 15, duration: 15, marksPerQ: 1, negative: 0, openFrom: addDays(today, -40), openTill: addDays(today, -5), attemptsAllowed: 1, showAnswers: false, published: true, instructions: '' },
    { title: 'Chemistry mock 1', classId: 'c11', subject: 'Chemistry', n: 30, duration: 60, marksPerQ: 4, negative: 1, openFrom: addDays(today, 3), attemptsAllowed: 1, showAnswers: true, published: true, instructions: '' },
    { title: 'English grammar mock', classId: 'c6', subject: 'English', n: 20, duration: 20, marksPerQ: 1, negative: 0, openFrom: today, attemptsAllowed: 3, showAnswers: true, published: false, instructions: '' },
  ];
  const mr = rng(999);
  const mockAttempts: Record<string, unknown>[] = [];
  for (const x of mockDefs) {
    const { n: count, ...rest } = x;
    const m = await MockTest.create({ ...rest, questions: qFor(x.subject, count) });
    if (!x.published || x.openFrom > today) continue;
    const pool = active.filter((s) => s.classId === x.classId && cat.classes.get(s.classId)!.subjects.some((sub) => s.subjectIds.includes(sub._id) && sub.name === x.subject));
    for (const s of pool) {
      if (mr() > 0.7) continue;
      const tries = Math.max(1, Math.min(x.attemptsAllowed || 3, 1 + Math.floor(mr() * 3)));
      for (let t = 1; t <= tries; t++) {
        const lastDay = x.openTill && x.openTill < today ? x.openTill : addDays(today, -1);
        const day = addDays(x.openFrom, Math.floor(mr() * Math.max(1, (Date.parse(lastDay) - Date.parse(x.openFrom)) / 86_400_000)));
        const startedAt = istInstant(day < today ? day : addDays(today, -1), `${between(mr, 10, 20)}:00`);
        const answers = answersFor(mr, m.questions, Math.min(0.98, abilityOf(s) + t * 0.04));
        const timeSec = Math.round(x.duration * 60 * (0.5 + mr() * 0.45));
        mockAttempts.push({ kind: 'MOCK', test: m._id, student: s._id, attemptNo: t, status: 'SUBMITTED', startedAt, deadline: new Date(startedAt.getTime() + x.duration * 60_000), submittedAt: new Date(startedAt.getTime() + timeSec * 1000), answers, ...score(m, answers), timeSec });
      }
    }
  }
  await Attempt.insertMany(mockAttempts);
  logger.info({ mocks: mockDefs.length, attempts: mockAttempts.length }, 'mock tests');

  /* Notice board */
  const at = (ago: number, h = 10) => istInstant(addDays(today, -ago), `${String(h).padStart(2, '0')}:00`);
  await Notice.insertMany([
    { title: 'Admissions open for 2026-27', body: '<p>Admissions are open for <b>Class 5 to 12 and college 1st–4th year</b> — English and Bengali medium. Apply from the Success Tutorials app or visit the centre.</p>', image: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=1200&q=70', audience: 'Public website', pinned: true, publishAt: at(6, 11), showOnWebsite: true, showOnApp: false, by: 'Srijit Saha' },
    { title: 'Puja holidays: classes resume on 27 Oct', body: '<p>The centre stays closed from <b>18 to 26 October</b> for Durga Puja. Wishing everyone a joyful Puja!</p>', audience: 'All students', pinned: true, publishAt: at(2), expires: '2026-10-27', showOnWebsite: true, by: 'Srijit Saha' },
    { title: 'Class 10: Saturday maths class moved to Sunday', body: '<p>This Saturday’s Mathematics class is moved to Sunday, same time.</p>', audience: 'Class', target: 'c10', publishAt: at(0, 9), expires: addDays(today, 5), kind: 'ROUTINE', by: 'Srijit Saha' },
    { title: 'Parent–teacher meeting on 1 Nov', body: '<p>All guardians are invited on Sunday 1 Nov, 11 AM at the centre.</p>', audience: 'All students', publishAt: at(-14), by: 'Srijit Saha' },
    { title: 'Spoken English: mock interview week', body: '<p>Bring your CV — every student gets a 10-minute mock interview.</p>', audience: 'Class', target: 'spoken', publishAt: at(1), expires: addDays(today, 10), by: 'Ritika Bose' },
  ]);

  /* Website & app marketing */
  await Banner.insertMany(
    [
      { title: 'Admissions open 2026-27', subtitle: 'Class 5 – 12 · College 1st – 4th year · English & Bengali medium', placement: 'Website home hero', image: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=1600&q=70', cta: 'Contact us', action: 'URL', link: '/contact', start: '2026-03-01', end: '2026-12-31', views: 18240, clicks: 1290 },
      { title: 'Results that speak', subtitle: 'Board and entrance results of our students', placement: 'Website home hero', image: 'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?w=1600&q=70', cta: 'See results', action: 'URL', link: '/results', start: '2026-09-01', end: '2026-12-31', views: 7020, clicks: 460 },
      { title: 'Weekly tests with rank', subtitle: 'Every chapter tested · results in the app', placement: 'App home carousel', image: 'https://images.unsplash.com/photo-1606326608606-aa0b62935f2b?w=1200&q=70', cta: 'See tests', action: 'SCREEN', link: '/tests', start: '2026-09-20', end: '2026-11-30', views: 4820, clicks: 612 },
      { title: 'Puja revision camp', subtitle: 'Physics · Chemistry · Maths', placement: 'App home carousel', image: 'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=1200&q=70', cta: 'Know more', action: 'SCREEN', link: '/notices', start: '2026-10-01', end: '2026-10-25', views: 1940, clicks: 251 },
    ].map((b, i) => ({ ...b, audience: 'All', active: true, order: i + 1 })),
  );
  await Ranker.insertMany(
    [
      { name: 'Arka Mukherjee', exam: 'WBJEE', year: '2026', result: 'Rank 46', className: 'Class 12', quote: 'The weekly mocks made the real exam feel familiar.', photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&q=70' },
      { name: 'Sreeja Dey', exam: 'Madhyamik', year: '2026', result: '94.6%', className: 'Class 10', quote: 'Teachers explained every chapter until it was clear.', photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=300&q=70' },
      { name: 'Rohan Biswas', exam: 'Higher Secondary', year: '2026', result: '92.2%', className: 'Class 12', quote: 'Regular tests kept me on track.' },
      { name: 'Madhurima Sen', exam: 'CBSE Class 10', year: '2026', result: '96.4%', className: 'Class 10', quote: '' },
      { name: 'Subhajit Kar', exam: 'JEE Main', year: '2026', result: '99.2 %ile', className: 'Class 12', quote: '', visible: false },
    ].map((x, i) => ({ visible: true, ...x, order: i + 1 })),
  );
  await Teacher.insertMany(
    [
      { name: 'Srijit Saha', subject: 'Physics', qualification: 'M.Sc. (Physics), B.Ed.', experience: '12 years', about: 'Founder. Makes physics feel like common sense.' },
      { name: 'Anirban Ghosh', subject: 'Chemistry', qualification: 'M.Sc. (Chemistry)', experience: '10 years', about: 'Known for short notes and memory tricks.' },
      { name: 'Ranjan Dey', subject: 'Mathematics', qualification: 'M.Sc. (Maths)', experience: '14 years', about: 'Board and entrance maths, step by step.' },
      { name: 'Mitali Sen', subject: 'Biology', qualification: 'M.Sc. (Zoology)', experience: '8 years', about: 'Diagrams, NCERT lines and lots of practice.' },
      { name: 'Ritika Bose', subject: 'English & Spoken English', qualification: 'M.A. (English)', experience: '6 years', about: '', visible: false },
    ].map((x, i) => ({ visible: true, ...x, order: i + 1 })),
  );

  /* Free classes */
  const fv = (classId: string, subject: string, title: string, id: string, duration: string, published = true) => ({ classId, subject, title, url: `https://www.youtube.com/watch?v=${id}`, youtubeId: id, duration, published });
  await FreeVideo.insertMany(
    [
      fv('c5', 'Mathematics', 'Fractions made easy', 'kKKM8Y-u7ds', '18:24'),
      fv('c7', 'Science', 'Plants and photosynthesis', 'riXcZT2ICjA', '14:02'),
      fv('c10', 'Mathematics', 'Quadratic equations — full chapter', 'FSyAehMdpyI', '42:10'),
      fv('c10', 'Physical Science', 'Light — reflection & refraction', 'WUvTyaaNkzM', '36:45'),
      fv('c9', 'Physical Science', 'Chemical reactions in one shot', 'aircAruvnKk', '28:30'),
      fv('c11', 'Physics', 'Kinematics in one shot', 'fNk_zzaMoSs', '51:12'),
      fv('c12', 'Mathematics', 'Limits — standard forms', 'YQHsXMglC9A', '33:40'),
      fv('c12', 'Mathematics', 'WBJEE 2025 Maths PYQ discussion', 'rfscVS0vtbw', '1:02:15', false),
    ].map((x, i) => ({ ...x, order: i + 1 })),
  );

  /* Courses (video lessons; PDFs are added in the panel once real files are uploaded) */
  const v = (title: string, id: string, duration: string, freePreview = false) => ({ title, kind: 'VIDEO', source: 'YOUTUBE', url: `https://www.youtube.com/watch?v=${id}`, youtubeId: youtubeId(id), duration, freePreview });
  const wbjee = await Course.create({
    title: 'WBJEE Crash Course',
    subtitle: 'Physics + Maths revision with PYQs',
    description: 'Chapter-wise one-shot videos for WBJEE. For students enrolled one by one.',
    cover: 'https://images.unsplash.com/photo-1606326608606-aa0b62935f2b?w=900&q=70',
    teacher: 'Srijit Saha',
    published: true,
    modules: [
      { title: 'Physics', lessons: [v('Kinematics in one shot', 'fNk_zzaMoSs', '51:12', true)] },
      { title: 'Mathematics', lessons: [v('Limits — standard forms', 'YQHsXMglC9A', '33:40'), v('WBJEE 2025 Maths PYQ discussion', 'rfscVS0vtbw', '1:02:15')] },
    ],
  });
  await Course.insertMany([
    {
      title: 'Spoken English',
      subtitle: 'Speak clearly and confidently — from basics to interviews',
      description: 'Daily-life English, pronunciation, grammar in use, group discussion and interview practice.',
      cover: 'https://images.unsplash.com/photo-1543269865-cbf427effbad?w=900&q=70',
      teacher: 'Ritika Bose',
      access: { classes: [], extras: ['spoken'] },
      published: true,
      modules: [
        { title: 'Module 1 · Basics & pronunciation', lessons: [v('Introduce yourself confidently', 'Ilg3gGewQ5U', '12:08', true), v('Vowel and consonant sounds', 'kKKM8Y-u7ds', '18:40')] },
        { title: 'Module 2 · Everyday conversation', lessons: [v('At the shop, bus stop and school', 'riXcZT2ICjA', '21:15'), v('Asking and giving directions', 'FSyAehMdpyI', '16:02')] },
        { title: 'Module 3 · Interview & presentation', lessons: [v('Answering “Tell me about yourself”', 'WUvTyaaNkzM', '14:30')] },
      ],
    },
    {
      title: 'Madhyamik Revision 2027',
      subtitle: 'Full-syllabus revision for Class 10',
      description: 'Short revision videos for every Class 10 student.',
      cover: 'https://images.unsplash.com/photo-1427504494785-3a9ca7044f45?w=900&q=70',
      teacher: 'Ranjan Dey',
      access: { classes: ['c10'], extras: [] },
      published: true,
      modules: [{ title: 'Mathematics', lessons: [v('Quadratic equations — full chapter', 'FSyAehMdpyI', '42:10')] }],
    },
    {
      title: 'Drawing Foundations',
      subtitle: 'Sketching, shading and colour',
      description: 'Step-by-step drawing lessons for the Drawing batch.',
      cover: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=900&q=70',
      teacher: 'Payel Kar',
      access: { classes: [], extras: ['drawing'] },
      published: false,
      modules: [{ title: 'Module 1 · Lines and shapes', lessons: [] }],
    },
  ]);
  const c12 = students.filter((s) => s.classId === 'c12' && s.status === 'ACTIVE').slice(0, 6);
  await Student.updateMany({ _id: { $in: c12.map((s) => s._id) } }, { $addToSet: { courseIds: wbjee._id } });

  logger.info({ monthlyFeeAnanya: feeOf(ananya, cat).monthly, dueDay }, 'demo data loaded — every demo student password is 1234');
}
