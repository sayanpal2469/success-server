/** Starting catalog — the same classes, subjects, fees and extras as the admin panel's demo data. */

type SubjectSeed = { _id: string; name: string; monthlyFee: number };

const sub = (cls: string, name: string, fee: number): SubjectSeed => ({ _id: `${cls}-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, name, monthlyFee: fee });
const make = (names: string[], extra: number[]) => (id: string, base: number) => names.map((n, i) => sub(id, n, base + extra[i]!));

const school58 = make(['Bengali', 'English', 'Mathematics', 'Science', 'History', 'Geography'], [0, 50, 100, 100, 0, 0]);
const school910 = make(['Bengali', 'English', 'Mathematics', 'Physical Science', 'Life Science', 'History', 'Geography'], [0, 100, 200, 150, 100, 0, 0]);
const hs = make(['Physics', 'Chemistry', 'Mathematics', 'Biology', 'English', 'Computer Science'], [100, 100, 100, 50, 0, 0]);
const college = make(['Mathematics', 'Physics', 'Chemistry', 'Statistics', 'English', 'Computer Science'], [100, 100, 100, 50, 0, 50]);

const M_E = ['Morning', 'Evening'];
const SCI = ['Science A', 'Science B'];

export const classes = [
  { _id: 'c5', name: 'Class 5', group: 'School', subjects: school58('c5', 150), batches: M_E, admissionFee: 0 },
  { _id: 'c6', name: 'Class 6', group: 'School', subjects: school58('c6', 150), batches: M_E, admissionFee: 0 },
  { _id: 'c7', name: 'Class 7', group: 'School', subjects: school58('c7', 175), batches: M_E, admissionFee: 0 },
  { _id: 'c8', name: 'Class 8', group: 'School', subjects: school58('c8', 200), batches: M_E, admissionFee: 0 },
  { _id: 'c9', name: 'Class 9', group: 'School', subjects: school910('c9', 200), batches: M_E, admissionFee: 200 },
  { _id: 'c10', name: 'Class 10', group: 'School', subjects: school910('c10', 250), batches: M_E, admissionFee: 200 },
  { _id: 'c11', name: 'Class 11', group: 'School', subjects: hs('c11', 400), batches: SCI, admissionFee: 500 },
  { _id: 'c12', name: 'Class 12', group: 'School', subjects: hs('c12', 450), batches: SCI, admissionFee: 500 },
  { _id: 'y1', name: '1st Year', group: 'College', subjects: college('y1', 500), batches: ['Weekend'], admissionFee: 500 },
  { _id: 'y2', name: '2nd Year', group: 'College', subjects: college('y2', 500), batches: ['Weekend'], admissionFee: 500 },
  { _id: 'y3', name: '3rd Year', group: 'College', subjects: college('y3', 550), batches: ['Weekend'], admissionFee: 500 },
  { _id: 'y4', name: '4th Year', group: 'College', subjects: college('y4', 550), batches: ['Weekend'], admissionFee: 500 },
].map((c, i) => ({ ...c, active: true, order: i + 1 }));

export const extras = [
  { _id: 'drawing', name: 'Drawing', description: 'Sketching, colour and art-exam preparation. Open to all classes.', monthlyFee: 300, teacher: 'Payel Kar' },
  { _id: 'spoken', name: 'Spoken English', description: 'Speaking, grammar in use, interviews and presentations.', monthlyFee: 500, teacher: 'Ritika Bose' },
  { _id: 'competitive', name: 'Competitive exams batch', description: 'WBJEE · JEE Main · NEET · Olympiad practice with weekly mocks.', monthlyFee: 800, teacher: 'Srijit Saha' },
].map((e, i) => ({ ...e, active: true, order: i + 1 }));

export const contact = {
  address: 'Munshirhat, Howrah – 711410',
  phone: '6296264592',
  whatsapp: '6296264592',
  email: 'successtutorialsofficial@gmail.com',
  hours: 'Mon – Sat · 10 AM – 8 PM',
  facebook: 'https://www.facebook.com/people/Success-Tutorials/61579448806440/',
  instagram: 'https://www.instagram.com/tutorials.success/',
};
