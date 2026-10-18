import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspaceDir = 'C:/Users/weerapat/photobooth';
const SKILL_DIR = 'C:/Users/weerapat/.codex/plugins/cache/openai-primary-runtime/presentations/26.1013.11914/skills/presentations';
const FINAL_PPTX = `${workspaceDir}/canva-files/Alumni-Reunion-2026-Editable.pptx`;
const stagingDir = `${workspaceDir}/.canva-build/finalizer`;
const candidatePath = `${workspaceDir}/.canva-build/candidate.pptx`;
const RUNTIME_PYTHON = 'C:/Users/weerapat/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(stagingDir, { recursive: true });
await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });

const requirements = {
  explicitTotalSlideCount: 1,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
};
const result = await finalizePresentation({
  ...requirements,
  workspaceDir,
  candidatePath,
  finalPath: FINAL_PPTX,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '3657600,5486400', '--validate-bullet-geometry', '--validate-heading-fit'],
  fontPolicy: { basis: 'design', families: ['Tahoma'] },
  verifyArtifactToolImport: true,
  receiptPath: `${stagingDir}/Alumni-Reunion-2026-Editable.validation.json`,
});
console.log(JSON.stringify(result, null, 2));
