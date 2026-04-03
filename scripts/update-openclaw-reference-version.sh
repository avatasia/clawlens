#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REFERENCE_REPO="${REPO_ROOT}/projects-ref/openclaw"
ARCH_DOC="${REPO_ROOT}/docs/architecture.md"

if [[ ! -d "${REFERENCE_REPO}/.git" ]]; then
  echo "Reference repo not found or not a git checkout: projects-ref/openclaw" >&2
  exit 1
fi

if [[ ! -f "${ARCH_DOC}" ]]; then
  echo "Architecture doc not found: docs/architecture.md" >&2
  exit 1
fi

short_sha="$(git -C "${REFERENCE_REPO}" rev-parse --short HEAD)"
name_rev="$(git -C "${REFERENCE_REPO}" name-rev --name-only --tags HEAD 2>/dev/null || true)"
branch_name="$(git -C "${REFERENCE_REPO}" branch --show-current 2>/dev/null || true)"

if [[ -n "${name_rev}" && "${name_rev}" != "undefined" ]]; then
  normalized_ref="${name_rev#tags/}"
  normalized_ref="${normalized_ref%\^0}"
elif [[ -n "${branch_name}" ]]; then
  normalized_ref="${branch_name}"
else
  normalized_ref="detached"
fi

version_text="OpenClaw ${normalized_ref} (${short_sha})"
new_line="- 当前参考版本：\`${version_text}\`"

tmp_file="$(mktemp)"
trap 'rm -f "${tmp_file}"' EXIT

awk -v new_line="${new_line}" '
  BEGIN { updated = 0 }
  /^- 当前参考版本：`/ {
    print new_line
    updated = 1
    next
  }
  { print }
  END {
    if (updated == 0) {
      exit 2
    }
  }
' "${ARCH_DOC}" > "${tmp_file}"

mv "${tmp_file}" "${ARCH_DOC}"
trap - EXIT

echo "Updated docs/architecture.md"
echo "Reference version: ${version_text}"
