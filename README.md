# Success Tutorials — API

REST API for the admin panel (`apps/admin`), the student app (`apps/mobile`) and the website (`apps/website`).
Express 5 · TypeScript · MongoDB (Mongoose) · Zod · JWT. Base URL `/api/v1`, JSON only.

## Run it

```bash
cp .env.example .env        # then set MONGODB_URI and two different 64-char JWT secrets
npm install
npm run seed                # admin account, settings, classes/subjects/fees, extra curriculums
npm run seed -- --demo      # + full demo data: 128 students (password 1234, Ananya = ST26-0142), payments,
                            #   requests, routine, exams with results, mocks, attendance, notices, website, courses
npm run seed -- --reset --demo   # wipe all data (admin accounts kept) and reload the demo
npm run dev                 # http://localhost:4100/api/v1
```

MongoDB must be a **replica set** (admissions and payments use transactions). MongoDB Atlas is one by default.
Locally: `mongod --replSet rs0 --port 27018 --dbpath <dir>` once, then `mongosh --port 27018 --eval "rs.initiate()"`.

`npm test` runs the integration tests against an in-memory replica set (downloads a MongoDB binary the first time).
`npm run build && npm start` for production.

## Rules the API enforces

- **Two roles only**: admin (email + password) and student (Student ID + password, no OTP). Access token 15 min; refresh token rotates on every use, and a reused old token signs that login out everywhere. Password change / reset / marking inactive signs the student out.
- **Fees**: monthly fee = chosen subjects + extra curriculums − discount; the admission fee is added to the first month. No payment gateway — the admin confirms money received by hand, which issues a receipt `ST/26-27/00001`. A month can be paid only once (database-enforced); a mistaken entry is voided with a reason, never deleted.
- **Exams**: questions go to the app without answers; timer and scoring are server-side; one attempt per student; questions lock when the exam starts. Results stay hidden until *Publish*, which also schedules the topper notice for the next day, for one day.
- **Mock tests**: open window, attempts limit (0 = unlimited), instant score, answer key only if `showAnswers`; questions lock after the first attempt.
- Students see only their class, their subjects (routine, tests) and their extra curriculums; every student query is scoped to the token.
- **Files**: `POST …/uploads/*` checks the real file type. Photos, banners and course material are public at `/uploads/<random>`; admission documents (Aadhaar …) are private and only open through signed links (`/files/<name>?exp&sig`, 30 min) that admin endpoints return.
- Errors are `{ error: { code, message, details? } }`. Dates are `YYYY-MM-DD` in India time; instants are ISO UTC.

## Endpoints

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/admin/login` · `POST /auth/student/login` · `POST /auth/refresh` · `POST /auth/logout` |
| Public (website + guests) | `GET /public/site` · `/catalog` · `/banners?placement` · `/announcements` · `/notices` · `/rankers` · `/teachers` · `/free-videos?classId` · `/courses` · `/reviews` · `/gallery` · `/posts` · `/faqs` · `POST /public/reviews` (pending until approved) · `POST /public/banners/:id/view\|click` · `POST /public/enquiries` (class + subjects, course, or free demo) · `POST /public/uploads/photo\|document` · `POST /public/admissions` (`source: APP\|WEBSITE`) · `POST /public/admissions/status` |
| Student | `GET /student/documents` (admission slip / form data for the app PDF) · `GET /student/me` · `PUT /student/password` · `GET /student/home` · `/id-card` · `/fees` · `/receipts/:id` · `/routine` · `/attendance?month` · `/notices` · `/performance` · `/courses` · `/courses/:id` · `PUT /student/lessons/:id/progress` · `GET /student/free-videos` |
| Student tests | `GET /student/tests` · `GET /student/exams/:id` · `POST /student/exams/:id/start` · `GET /student/exams/:id/result` · `GET /student/mocks/:id` · `POST /student/mocks/:id/start` · `PUT /student/attempts/:id/answers` · `POST /student/attempts/:id/submit` · `GET /student/attempts/:id` |
| Admin · students | `GET/POST /admin/students` · `GET/PATCH /admin/students/:id` · `POST …/:id/renew` · `…/:id/status` · `…/:id/reset-password` · `GET …/:id/performance` · `POST …/:id/feedback` · `DELETE /admin/feedback/:id` · `GET /admin/id-cards` · `GET /admin/applications` · `GET /admin/applications/:id` · `POST …/:id/approve` · `POST …/:id/reject` · `GET /admin/enquiries` · `PATCH/DELETE /admin/enquiries/:id` · website `/admin/reviews` `/admin/gallery` `/admin/faqs` (CRUD + `PUT …/order`) · `/admin/posts` (CRUD) |
| Admin · fees | `GET/POST /admin/payments` · `GET/DELETE /admin/payments/:id` · pending fees = `GET /admin/students?fee=OVERDUE` · WhatsApp reminder log `GET/POST /admin/fee-reminders` (message text: `reminderTemplate` in `/admin/settings`) |
| Admin · catalog | `GET/POST /admin/classes` · `PATCH/DELETE /admin/classes/:id` · `GET/POST /admin/extras` · `PATCH/DELETE /admin/extras/:id` · `GET/POST /admin/extras/:id/students` · `GET/PATCH /admin/settings` · `GET/PATCH /admin/me` · `PUT /admin/me/password` |
| Admin · tests | `GET/POST /admin/exams` · `GET/PATCH/DELETE /admin/exams/:id` · `GET …/:id/results` · `POST …/:id/publish` · `GET/POST /admin/mocks` · `GET/PATCH/DELETE /admin/mocks/:id` · `GET …/:id/board` |
| Admin · schedule | `GET/POST /admin/routine` · `PATCH/DELETE /admin/routine/:id` · `GET/POST /admin/routine/changes` · `DELETE /admin/routine/changes/:id` · `GET/PUT /admin/attendance/register` · `GET /admin/attendance/day` · `GET /admin/attendance/report` |
| Admin · content | `/admin/notices` · `/admin/banners` · `/admin/rankers` · `/admin/teachers` · `/admin/free-videos` (list/create/`PATCH`/`DELETE`, `PUT …/order`) · `GET/PUT /admin/website/contact` · `/admin/courses` (+ `GET/POST …/:id/students`) · `POST /admin/uploads/image\|pdf\|video\|doc` |
| Admin · reports | `GET /admin/dashboard` · `GET /admin/report-cards?session&studentId\|classId` · `GET /admin/backup?classId` (sheets for the .xlsx) |

## Layout

```
src/
├── app.ts, server.ts         Express app (helmet, CORS, rate limits, static files) and process entry
├── config/env.ts             validated environment
├── db/                       connection, toJSON plugin (id instead of _id)
├── lib/                      auth (bcrypt, JWT, refresh rotation), files (uploads, signed links), time (India dates), validate (Zod helpers), errors
├── models/                   org (admin, sessions, counters, settings) · catalog (classes, extras) · students (students, applications, payments, feedback) · enquiries · schedule · tests · content
├── services/                 fees ledger, admissions & receipts, exam/mock engine, performance, notices, courses
├── routes/                   auth · public · student/ · admin/
└── seed/                     npm run seed
tests/                        integration tests (vitest + supertest + in-memory MongoDB)
```

## Not wired yet

SMS / WhatsApp sending (office passwords, absence alerts, fee reminders) needs a provider account — the API returns the password / guardian list for the office to send for now. Push notifications are the same.

## Deploy

- Build: `npm run build` (TypeScript → `dist/`). Start: `node server.js` (`npm start`) — the entry file is `server.js` in this folder.
- Set the variables from `.env.example` in the host's dashboard (`NODE_ENV=production`, `MONGODB_URI`, two different 32+ character `JWT_*_SECRET`s, `CORS_ORIGINS` with the website and admin domains, `TRUST_PROXY=1` behind a proxy, `UPLOAD_DIR` on a persistent disk). A `.env` file is read only if present — never upload one.
- Upload without secrets: `api-deploy.zip` holds `package.json`, `package-lock.json`, `server.js`, the tsconfigs and `src/` (no `.env`, tests, `node_modules`, `dist`, `uploads`).
