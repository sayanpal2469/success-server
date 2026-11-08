import { logger } from '../lib/logger.js';
import { Faq, GalleryPhoto, Post, Review } from '../models/content.js';

/**
 * SAMPLE website content (reviews, gallery, blog, FAQs) so the pages aren't empty. Each collection
 * is filled only while it is empty, so the admin's own edits are never touched. Replace it from
 * the admin panel (Website › …) before going live.
 */

const u = (id: string, w = 900) => `https://images.unsplash.com/${id}?w=${w}&q=70&auto=format&fit=crop`;

const reviews = [
  { name: 'Mrs. Sharmila Das', role: 'Parent of a Class 10 student', text: 'We get attendance and test marks every week. As parents we always know where our child stands.', rating: 5 },
  { name: 'Arka Mukherjee', role: 'Student, WBJEE 2026', text: 'Small batch, so the teacher knew exactly which chapters I was weak in. The mock tests felt like the real exam.', rating: 5 },
  { name: 'Mr. Tapas Saha', role: 'Parent of a Class 12 student', text: 'Fees are clear and the teachers call us if there is any problem. Very disciplined institute.', rating: 5 },
  { name: 'Puja Halder', role: 'Student, CBSE 2025', text: 'Recorded classes in the app saved me during my exams — I could rewatch any topic at night.', rating: 4 },
];

const gallery = [
  { album: 'Classroom', image: u('photo-1509062522246-3755977927d7'), caption: 'Students in a classroom' },
  { album: 'Classroom', image: u('photo-1503676260728-1c00da094a0b'), caption: 'Teacher explaining on the board' },
  { album: 'Study', image: u('photo-1434030216411-0b793f4b4173'), caption: 'Student writing notes' },
  { album: 'Results day', image: u('photo-1427504494785-3a9ca7044f45'), caption: 'Results day celebration' },
  { album: 'Study', image: u('photo-1606326608606-aa0b62935f2b'), caption: 'Mock test answer sheet' },
  { album: 'Classroom', image: u('photo-1524178232363-1fb2b075b655'), caption: 'Students together after class' },
  { album: 'Science', image: u('photo-1532094349884-543bc11b234d'), caption: 'Chemistry practical' },
  { album: 'Results day', image: u('photo-1523580494863-6f3031224c94'), caption: 'Students celebrating results' },
];

const posts = [
  {
    slug: 'madhyamik-2027-study-plan',
    title: 'Madhyamik 2027: a month-by-month study plan',
    excerpt: 'Finish the syllabus by December, revise twice, and spend February on full papers. Here is how to split it.',
    date: '2026-09-28',
    tags: ['Madhyamik', 'Study plan'],
    body: `<p>The Madhyamik syllabus is long, but it is very predictable. A simple plan beats last-minute panic every time.</p>
<h2>October – December: finish the syllabus</h2>
<p>Take one chapter per subject per week. After each chapter, solve the previous-year questions from it the same weekend.</p>
<h2>January: first full revision</h2>
<ul><li>Revise formulas and definitions every morning for 20 minutes.</li><li>Take one subject test every Sunday.</li></ul>
<h2>February: full papers</h2>
<p>Sit for full 3-hour papers at the real exam time. Check your answers against the marking scheme, not just the final answer.</p>`,
  },
  {
    slug: 'wbjee-physics-chapters',
    title: '8 Physics chapters that decide your WBJEE rank',
    excerpt: 'Mechanics, optics and electrostatics carry most of the marks. Start with these before anything else.',
    date: '2026-09-12',
    tags: ['WBJEE', 'Physics'],
    body: `<p>Looking at the last ten WBJEE papers, a handful of chapters bring most of the Physics marks.</p>
<ol><li>Kinematics and laws of motion</li><li>Work, energy and power</li><li>Ray optics</li><li>Electrostatics</li><li>Current electricity</li><li>Magnetism</li><li>Modern physics</li><li>Thermodynamics</li></ol>
<p>Master these first, then fill in the rest. Our weekly mocks follow the same weightage.</p>`,
  },
  {
    slug: 'english-or-bengali-medium',
    title: 'English or Bengali medium — does it matter for entrance exams?',
    excerpt: 'WBJEE is bilingual, NEET is available in Bengali. What matters more is understanding the concept.',
    date: '2026-08-30',
    tags: ['Guidance'],
    body: `<p>Many parents ask whether a Bengali medium student can crack an entrance exam. The short answer: yes.</p>
<p>WBJEE question papers are available in both English and Bengali, and NEET is offered in Bengali as well. What decides the rank is how well the student understands the concept — and that happens fastest in the language they think in.</p>
<p>At Success Tutorials we teach in both mediums, so students can move to English terminology gradually without losing understanding.</p>`,
  },
];

const faqs = [
  { q: 'Which classes do you teach?', a: 'School classes and college years, in English and Bengali medium. Pick your class in the enquiry form to see the subjects we teach.' },
  { q: 'Do you teach in Bengali medium?', a: 'Yes. We teach both English and Bengali medium students.' },
  { q: 'Is there a free demo class?', a: 'Yes. Book a free demo from this website or call us — you can attend a real class before taking admission.' },
  { q: 'How are fees charged?', a: 'A monthly fee for the subjects you choose (plus any extra curriculum), with a one-time admission fee. You pay at the office and get a receipt in the app.' },
  { q: 'What if my child misses a class?', a: 'Recorded lessons and notes for many topics are in the Success Tutorials app.' },
  { q: 'How do parents know about progress?', a: 'Attendance, test results and fees are in the student’s app, and you can always call the office.' },
];

export async function seedWebsiteContent() {
  const filled: string[] = [];
  if (!(await Review.exists({}))) {
    await Review.insertMany(reviews.map((r, i) => ({ ...r, status: 'APPROVED', source: 'ADMIN', order: i + 1 })));
    filled.push('reviews');
  }
  if (!(await GalleryPhoto.exists({}))) {
    await GalleryPhoto.insertMany(gallery.map((g, i) => ({ ...g, order: i + 1 })));
    filled.push('gallery');
  }
  if (!(await Post.exists({}))) {
    await Post.insertMany(posts);
    filled.push('blog');
  }
  if (!(await Faq.exists({}))) {
    await Faq.insertMany(faqs.map((f, i) => ({ ...f, order: i + 1 })));
    filled.push('faqs');
  }
  logger.info({ filled }, filled.length ? 'sample website content added' : 'website content already there — left unchanged');
}
