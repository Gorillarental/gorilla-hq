// ============================================================
// SKILLS LOADER — Gorilla HQ
// Drop .md files into /skills to add capabilities to any agent.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, 'skills');

// Strip YAML frontmatter from skill files
function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  return end === -1 ? content : content.slice(end + 3).trim();
}

// Load one or more skills by name (filename without .md)
// Returns a formatted string ready to append to a system prompt
export function loadSkills(names = []) {
  const loaded = [];
  for (const name of names) {
    const fp = path.join(SKILLS_DIR, `${name}.md`);
    if (!fs.existsSync(fp)) {
      console.warn(`[Skills] Skill not found: ${name}`);
      continue;
    }
    const content = stripFrontmatter(fs.readFileSync(fp, 'utf8'));
    loaded.push(content);
  }
  if (!loaded.length) return '';
  return '\n\n' + loaded.join('\n\n---\n\n');
}

// Load all skills in the /skills directory
export function loadAllSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return '';
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
  const names = files.map(f => f.replace('.md', ''));
  return loadSkills(names);
}

// List available skills
export function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}
