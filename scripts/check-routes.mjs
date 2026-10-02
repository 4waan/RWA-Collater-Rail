import { access, readFile } from "node:fs/promises";

const routes = [
  ["packages/nextjs/app/page.tsx", "Finance ATS securities on Hedera."],
  ["packages/nextjs/app/facility/page.tsx", "FacilityConsole"],
  ["packages/nextjs/app/verify/page.tsx", "VerifyConsole"],
];

for (const [file, needle] of routes) {
  await access(file);
  const content = await readFile(file, "utf8");
  if (!content.includes(needle))
    throw new Error(`${file} does not contain ${needle}.`);
}
console.log("All required application routes are present.");
