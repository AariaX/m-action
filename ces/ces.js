import { isDeepEqual, compare, getChangedPaths } from "./deepEq.js";
import makeFetchCookie from "fetch-cookie";
import * as cheerio from "cheerio";

import {
  select,
  text as promptText,
  password as promptPassword,
  confirm as promptConfirm,
  isCancel,
  intro,
  outro,
  note,
  tasks,
  log,
} from "@clack/prompts";
import chalk from "chalk";

const { CookieJar, MemoryCookieStore } = makeFetchCookie.toughCookie;
const jar = new CookieJar(new MemoryCookieStore());
const fetchCookie = makeFetchCookie(fetch, jar);

const DEFAULT_UID = "";
const DEFAULT_PWD = "";

function extractBuildKey(html) {
  const m = html.match(/name=buildkey value=([a-zA-Z0-9]+)/i);
  return m ? m[1] : null;
}

function parseGrades(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const semesters = [];

  $('font[face="CordiaUPC"]').each((i, el) => {
    const header = $(el).text().trim();
    const semMatch = header.match(/(\d+\/\d+)/);
    const title = semMatch ? semMatch[1] : header || `Semester ${i + 1}`;
    const table = $(el).closest("table");
    const courses = [];
    table.find('tr[bgcolor="#F6F6FF"]').each((j, tr) => {
      const tds = $(tr).find("td");
      const code = (tds.eq(0).text() || "").replace(/\u00A0/g, " ").trim();
      const name = (tds.eq(1).text() || "").replace(/\u00A0/g, " ").trim();
      const credits = (tds.eq(2).text() || "").trim();
      const grade = (tds.eq(3).text() || "").trim();
      if (code || name) courses.push({ code, name, credits, grade });
    });
    if (courses.length > 0) semesters.push({ title, courses });
  });

  if (semesters.length === 0) {
    const fallback = { title: "All", courses: [] };
    $("tr").each((i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 3) {
        const code = (tds.eq(0).text() || "").replace(/\u00A0/g, " ").trim();
        if (/^[A-Z]{2,}\d{2}-\d{3}/i.test(code)) {
          const name = (tds.eq(1).text() || "").replace(/\u00A0/g, " ").trim();
          const credits = (tds.eq(2).text() || "").trim();
          const grade = (tds.eq(3).text() || "").trim();
          fallback.courses.push({ code, name, credits, grade });
        }
      }
    });
    if (fallback.courses.length) semesters.push(fallback);
  }

  let summary = [];
  const summaryTable = $("tr[bgcolor='#FFFFFF']");

  for (const semesterSummary of summaryTable) {
    summary.push({});

    const text = $(semesterSummary).text();
    const parts = text.match(/([A-Z]{2,}\d+(\.\d+)?)/g).slice(0, 5);

    summary[summary.length - 1] = {
      CA: parts[0].slice(2),
      CS: parts[1].slice(2),
      CG: parts[2].slice(2),
      GP: parts[3].slice(2),
      GPA: parts[4].slice(3),
    };
  }

  return { semesters, summary };
}

async function fetchLoginAndGrades(uid, pwd, opts = {}) {
  const logger = opts.logger || (() => {});
  try {
    logger("GET login page...");
    const loginUrl = "https://ces.wu.ac.th/registrar/login.asp";
    const validateUrl = "https://ces.wu.ac.th/registrar/validate.asp";
    const loginResp = await fetchCookie(loginUrl);
    const loginHtml = await loginResp.text();
    const buildkey = extractBuildKey(loginHtml) || "";

    logger("POST login...");
    const postBody = new URLSearchParams({ f_uid: uid, f_pwd: pwd, buildkey });

    await fetchCookie(validateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postBody,
      redirect: "manual",
    });

    logger("GET grades...");

    const res = await fetchCookie("https://ces.wu.ac.th/registrar/grade.asp");
    const gradeHtml = await res.text();

    logger("Parsing...");
    const parsed = parseGrades(gradeHtml);

    logger("Done");
    return { parsed, raw: gradeHtml };
  } catch (err) {
    logger(`Error: ${String(err.message || err)}`);
    throw err;
  }
}

async function promptCredentials(defaults = {}) {
  const uid = await promptText({
    message: "CES UID:",
    placeholder: defaults.uid || DEFAULT_UID || "",
    initialValue: defaults.uid || DEFAULT_UID || "",
  });

  if (isCancel(uid)) return null;

  const pwd = await promptPassword({
    message: "Password:",
    placeholder: defaults.pwd ? "[hidden]" : "",
    validate: (v) => (v && v.length ? true : "Password is required"),
  });
  if (isCancel(pwd)) return null;

  return { uid: String(uid).trim(), pwd: String(pwd) };
}

async function chooseSemester(parsed) {
  if (!parsed || !parsed.semesters || parsed.semesters.length === 0)
    return null;
  const choices = parsed.semesters.map((s, i) => ({
    label: `${s.title} (${s.courses.length})`,
    value: String(i),
  }));
  choices.push({ label: "Back", value: "-1" });

  const pick = await select({
    message: "Select semester",
    options: choices,
  });

  if (isCancel(pick) || pick === null) return null;
  const idx = Number(pick);
  if (Number.isNaN(idx) || idx < 0) return null;
  return idx;
}

async function mainMenuLoop(state) {
  while (true) {
    const opt = await select({
      message: `CES Interactive — logged in as ${state.uid || "(not set)"}`,
      options: [
        { label: "View semesters", value: "view_sem" },
        { label: "Refresh grades", value: "refresh" },
        {
          label: state.watch ? "Stop watching grades" : "Watch grades",
          value: "watch_grades",
        },
        { label: "Quit", value: "quit" },
      ],
    });

    if (isCancel(opt) || opt === null) {
      const shouldQuit = await promptConfirm({ message: "Exit the program?" });
      if (isCancel(shouldQuit)) continue;
      if (shouldQuit) return;
      else continue;
    }

    const action = String(opt);

    if (action === "quit") {
      return;
    }

    if (action === "refresh") {
      if (!state.uid || !state.pwd) {
        log.error("No credentials set. Choose 'Change credentials' first.");
        continue;
      }

      await tasks([
        {
          title: "Refreshing grades",
          task: async () => {
            const { parsed, raw } = await fetchLoginAndGrades(
              state.uid,
              state.pwd,
            );

            state.parsed = parsed;
            state.raw = raw;

            return "Refreshed grades successfully";
          },
        },
      ]);

      continue;
    }

    if (action === "view_sem") {
      if (!state.parsed) {
        note("No data. Refresh to fetch grades.");
        continue;
      }

      const semIndex = await chooseSemester(state.parsed);
      if (semIndex === null) continue;

      const sem = state.parsed.semesters[semIndex];
      let courseLines = [];

      for (const course of sem.courses) {
        const codeStr = course.code;
        const nameStr = course.name;
        const creditsStr = course.credits;
        const gradeRaw = (course.grade || "").toString().trim();
        const g = gradeRaw.toUpperCase();

        let gradeColored;
        if (/^[A-FS][+-]?$/.test(g)) {
          if (g.startsWith("A") || g.startsWith("S"))
            gradeColored = chalk.green(gradeRaw);
          else if (g.startsWith("B")) gradeColored = chalk.yellow(gradeRaw);
          else if (g.startsWith("C")) gradeColored = chalk.magenta(gradeRaw);
          else gradeColored = chalk.red(gradeRaw);
        } else if (/^\d+(\.\d+)?$/.test(gradeRaw)) {
          const num = parseFloat(gradeRaw);
          if (num >= 3.0) gradeColored = chalk.green(gradeRaw);
          else if (num >= 2.0) gradeColored = chalk.yellow(gradeRaw);
          else gradeColored = chalk.red(gradeRaw);
        } else gradeColored = chalk.yellow(gradeRaw);

        courseLines.push(
          `${chalk.blue(codeStr)} — ${nameStr} [${creditsStr}] - ${chalk.bold(gradeColored)}`,
        );
      }

      log.message(courseLines.join("\n"));

      const summary =
        (state.parsed.summary && state.parsed.summary[semIndex]) || null;

      if (!summary) {
        log.log(`\n${sem.title} — No summary available\n`);
        continue;
      }

      log.message(
        [
          `${chalk.bold("CA")}  : ${summary.CA ?? "N/A"}`,
          `${chalk.bold("CS")}  : ${summary.CS ?? "N/A"}`,
          `${chalk.bold("CG")}  : ${summary.CG ?? "N/A"}`,
          `${chalk.bold("GP")}  : ${summary.GP ?? "N/A"}`,
          `${chalk.bold("GPA")} : ${summary.GPA ?? "N/A"}`,
        ].join("\n"),
      );

      continue;
    }

    if (action === "watch_grades") {
      if (state.watch) {
        log.info("Stopping background grade watcher...");
        clearInterval(state.watch);
      } else {
        log.info("Watching grades in the background...");
        checkGrades(state);

        state.watch = setInterval(
          () => {
            checkGrades(state);
          },
          5 * 60 * 1000,
        );
      }

      continue;
    }
  }
}

async function checkGrades(state) {
  const { parsed, raw } = await fetchLoginAndGrades(state.uid, state.pwd);
  state.parsed = parsed;
  state.raw = raw;

  //FIXME: First semester is hardcoded
  const currentGrades = state.parsed.semesters[0];
  const oldGrades = Bun.file("grades.json");
  const fileExists = await oldGrades.exists();

  if (fileExists) {
    const text = await oldGrades.text();
    const oldGradesJson = JSON.parse(text);

    const eq_results = isDeepEqual(oldGradesJson, currentGrades);

    if (!eq_results) {
      const diffs = compare(oldGradesJson, currentGrades);
      const changedCoures = getChangedPaths(diffs)
        .map((d) => d.replace(/^courses\.\[(\d+).*\]\.grade$/, "$1"))
        .map((c) => currentGrades.courses[Number.parseInt(c)]);

      const webhookUrl = "";
      const payload = {
        content: `Grades updated for semester: ${currentGrades.title}`,
        embeds: [
          {
            title: `Grades for ${currentGrades.title}`,
            fields: changedCoures.map((course) => ({
              name: `${course.code} - ${course.name}`,
              value: `Credits: ${course.credits}, Grade: **${course.grade}**`,
              inline: false,
            })),
            color: 5814783,
            timestamp: new Date().toISOString(),
          },
        ],
      };

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  }

  Bun.write("grades.json", JSON.stringify(currentGrades));
}

async function run() {
  intro("CES Interactive CLI");

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node login.js\nThis script launches an interactive CLI using @clack/prompts.\nEnvironment: CES_UID, CES_PWD",
    );
    outro("help displayed");
    return;
  }

  const state = {
    uid: DEFAULT_UID,
    pwd: DEFAULT_PWD,
    parsed: null,
    raw: null,
  };

  await tasks([
    {
      title: "Logging in and fetching grades",
      task: async () => {
        const { parsed, raw } = await fetchLoginAndGrades(state.uid, state.pwd);
        state.parsed = parsed;
        state.raw = raw;

        return "Fetched grades successfully";
      },
    },
  ]);

  await mainMenuLoop(state);
  outro("Goodbye");

  process.exit(0);
}

if (import.meta && import.meta.url && process.argv) {
  run();
}
