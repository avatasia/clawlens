import fs from "node:fs";
import path from "node:path";

/**
 * Gemini Stop Hook render-order patch
 *
 * Goal:
 * - Keep Gemini's existing hook info rendering style
 * - Fix only the render position
 * - If a hook message arrives while Gemini still has pending response content,
 *   queue it and append it after the pending response is committed to history
 *
 * Usage:
 *   node scripts/patch-gemini-stophook.mjs
 *   node scripts/patch-gemini-stophook.mjs --restore
 */

const bundleDir = process.env.GEMINI_BUNDLE_DIR ?? "/usr/lib/node_modules/@google/gemini-cli/bundle/";
const isRestore = process.argv.includes("--restore");

if (!fs.existsSync(bundleDir)) {
    console.error(`Error: Bundle directory not found at ${bundleDir}`);
    process.exit(1);
}

const queuePatchMarker = "StopHook Deferred HookSystemMessage Patch";
const notificationsPatchMarker = "StopHook Hide Hook Status Patch";
const obsoletePersistentTimerMarker = "StopHook Persistent TimedMessage Patch";
const obsoleteClearOnSubmitMarker = "StopHook Clear Persistent Message On Submit";
const obsoleteHistoryPatchMarker = "StopHook Hook Events History Patch";
const oldHackMarker = "StopHook Patch Start";

const hookEffectSearch = /\(0, import_react124\.useEffect\)\(\(\) => \{\s*const handleUserFeedback = \(payload\) => \{[\s\S]*?coreEvents\.drainBacklogs\(\);\s*return \(\) => \{[\s\S]*?coreEvents\.off\((?:"hook-system-message" \/\* HookSystemMessage \*\/|CoreEvent\.HookSystemMessage), handleHookSystemMessage\);\s*\};\s*\}, \[historyManager\]\);/m;

const hookEffectReplace = `const queuedHookSystemMessagesRef = (0, import_react124.useRef)([]);
  const pendingHistoryItemsRef = (0, import_react124.useRef)(pendingHistoryItems);
  const flushQueuedHookSystemMessages = (0, import_react124.useCallback)(() => {
    if (queuedHookSystemMessagesRef.current.length === 0) {
      return;
    }
    const queuedMessages = queuedHookSystemMessagesRef.current;
    queuedHookSystemMessagesRef.current = [];
    for (const payload of queuedMessages) {
      historyManager.addItem(
        {
          type: "info" /* INFO */,
          text: payload.message,
          source: payload.hookName
        },
        Date.now()
      );
    }
  }, [historyManager]);
  (0, import_react124.useEffect)(() => {
    // --- ${queuePatchMarker} ---
    pendingHistoryItemsRef.current = pendingHistoryItems;
    if (pendingHistoryItems.length === 0) {
      flushQueuedHookSystemMessages();
    }
  }, [pendingHistoryItems, flushQueuedHookSystemMessages]);
  (0, import_react124.useEffect)(() => {
    const handleUserFeedback = (payload) => {
      let type;
      switch (payload.severity) {
        case "error":
          type = "error" /* ERROR */;
          break;
        case "warning":
          type = "warning" /* WARNING */;
          break;
        case "info":
          type = "info" /* INFO */;
          break;
        default:
          throw new Error(
            \`Unexpected severity for user feedback: \${payload.severity}\`
          );
      }
      historyManager.addItem(
        {
          type,
          text: payload.message
        },
        Date.now()
      );
      if (payload.error) {
        debugLogger.warn(
          \`[Feedback Details for "\${payload.message}"]\`,
          payload.error
        );
      }
    };
    const handleHookSystemMessage = (payload) => {
      if (pendingHistoryItemsRef.current.length > 0) {
        queuedHookSystemMessagesRef.current.push(payload);
        return;
      }
      historyManager.addItem(
        {
          type: "info" /* INFO */,
          text: payload.message,
          source: payload.hookName
        },
        Date.now()
      );
    };
    coreEvents.on("user-feedback" /* UserFeedback */, handleUserFeedback);
    coreEvents.on("hook-system-message" /* HookSystemMessage */, handleHookSystemMessage);
    coreEvents.drainBacklogs();
    flushQueuedHookSystemMessages();
    return () => {
      coreEvents.off("user-feedback" /* UserFeedback */, handleUserFeedback);
      coreEvents.off("hook-system-message" /* HookSystemMessage */, handleHookSystemMessage);
    };
  }, [historyManager, flushQueuedHookSystemMessages]);`;

const statusNodeRenderSearch = /if \(activeHooks\.length === 0 && !showLoadingIndicator\) return null;\s*let currentLoadingPhrase = void 0;\s*let currentThought = null;\s*if \(activeHooks\.length > 0\) \{/m;
const statusNodeRenderReplace = `const effectiveActiveHooks = [];
  // --- ${notificationsPatchMarker} ---
  if (effectiveActiveHooks.length === 0 && !showLoadingIndicator) return null;
  let currentLoadingPhrase = void 0;
  let currentThought = null;
  if (effectiveActiveHooks.length > 0) {`;

const statusNodeVisibleHooksSearch = /const userVisibleHooks = activeHooks\.filter\(/m;
const statusNodeVisibleHooksReplace = `const userVisibleHooks = effectiveActiveHooks.filter(`;

const statusRowMinimalSearch = /const showRow1Minimal = showLoadingIndicator \|\| uiState\.activeHooks\.length > 0 \|\| showTipLine;/m;
const statusRowMinimalReplace = `const showRow1Minimal = showLoadingIndicator || showTipLine;`;

const statusNodePropsSearch = /activeHooks:\s*(?:settings\.merged\.hooksConfig\.notifications\s*\?\s*uiState\.activeHooks\s*:\s*\[\]|uiState\.activeHooks|\[\]),(?:\n\s*notificationsEnabled:\s*settings\.merged\.hooksConfig\.notifications,)?/m;
const statusNodePropsReplace = `activeHooks: [],`;

const patchedStatusNodeSignatureSearch = /var StatusNode = \(\{\s*showTips,\s*showWit,\s*thought,\s*elapsedTime,\s*currentWittyPhrase,\s*activeHooks,\s*notificationsEnabled,\s*showLoadingIndicator,\s*errorVerbosity,\s*onResize\s*\}\) => \{/m;
const originalStatusNodeSignatureReplace = `var StatusNode = ({
  showTips,
  showWit,
  thought,
  elapsedTime,
  currentWittyPhrase,
  activeHooks,
  showLoadingIndicator,
  errorVerbosity,
  onResize
}) => {`;

const brokenEffectiveActiveHooksSearch = /const effectiveActiveHooks = (?:settings\.merged\.hooksConfig\.notifications|notificationsEnabled) \? activeHooks : \[\];/m;
const fixedEffectiveActiveHooksReplace = `const effectiveActiveHooks = [];`;

const obsoleteTimedMessageSearch = new RegExp(
    `// --- ${obsoletePersistentTimerMarker} ---\\s*if \\(msg !== null && !msg\\.persistent\\) \\{\\s*timeoutRef\\.current = setTimeout\\(\\(\\) => \\{\\s*setMessage\\(null\\);\\s*\\}, durationMs\\);\\s*\\}`,
    "m"
);
const originalTimedMessage = `if (msg !== null) {
        timeoutRef.current = setTimeout(() => {
          setMessage(null);
        }, durationMs);
      }`;

const obsoleteSubmitClearSearch = new RegExp(
    `\\n\\s*// --- ${obsoleteClearOnSubmitMarker} ---\\n\\s*appEvents\\.emit\\("transient-message" /\\* TransientMessage \\*/, \\{\\n\\s*message: null,\\n\\s*type: "hint" /\\* Hint \\*/\\n\\s*\\}\\);`,
    "m"
);

const obsoleteTransientHandlerSearch = /const handleTransientMessage = \(payload\) => \{\s*if \(payload\.message === null\) \{\s*showTransientMessage\(null\);\s*return;\s*\}\s*showTransientMessage\(\{ text: payload\.message, type: payload\.type \}\);\s*\};/m;
const originalTransientHandler = `const handleTransientMessage = (payload) => {
      showTransientMessage({ text: payload.message, type: payload.type });
    };`;

if (isRestore) {
    console.log("Restoring original files from backups...");
    const files = fs.readdirSync(bundleDir);
    let restoredCount = 0;

    for (const file of files) {
        if (!file.endsWith(".js.bak")) {
            continue;
        }
        const backupPath = path.join(bundleDir, file);
        const originalPath = backupPath.slice(0, -4);
        try {
            fs.copyFileSync(backupPath, originalPath);
            fs.unlinkSync(backupPath);
            console.log(`  Restored: ${path.basename(originalPath)}`);
            restoredCount++;
        } catch (e) {
            console.error(`  Failed to restore ${file}: ${e.message}`);
        }
    }

    if (restoredCount === 0) {
        console.log("No backup files found to restore.");
    } else {
        console.log(`\nSuccessfully restored ${restoredCount} files. Restart your gemini session.`);
    }
    process.exit(0);
}

console.log("Applying patches...");
let patchedCount = 0;
let failedCount = 0;

const interactiveFiles = fs.readdirSync(bundleDir)
    .filter(file => /^interactiveCli-.*\.js$/.test(file))
    .map(file => path.join(bundleDir, file));

for (const filePath of interactiveFiles) {
    const fileName = path.basename(filePath);
    const originalContent = fs.readFileSync(filePath, "utf8");
    let newContent = originalContent;

    newContent = newContent
        .replace(obsoleteTimedMessageSearch, originalTimedMessage)
        .replace(obsoleteSubmitClearSearch, "")
        .replace(obsoleteTransientHandlerSearch, originalTransientHandler)
        .replace(patchedStatusNodeSignatureSearch, originalStatusNodeSignatureReplace)
        .replace(brokenEffectiveActiveHooksSearch, fixedEffectiveActiveHooksReplace);

    if (newContent.includes(queuePatchMarker)) {
        console.log(`  ${fileName} queue patch already present.`);
    } else if (hookEffectSearch.test(newContent)) {
        newContent = newContent.replace(hookEffectSearch, hookEffectReplace);
    } else {
        console.log(`  Target hook render-order effect not found in ${fileName}.`);
    }

    if (newContent.includes(notificationsPatchMarker)) {
        console.log(`  ${fileName} hide-hook-status patch already present.`);
    }
    newContent = newContent
        .replace(statusNodeRenderSearch, statusNodeRenderReplace)
        .replace(statusNodeVisibleHooksSearch, statusNodeVisibleHooksReplace)
        .replace(statusRowMinimalSearch, statusRowMinimalReplace)
        .replace(statusNodePropsSearch, statusNodePropsReplace);

    // Remove the previous mistaken hook-start history patch if it exists in-place.
    newContent = newContent.replace(
        /\n\s*const handleHookStartHistory = \(payload\) => \{[\s\S]*?\n\s*coreEvents\.on\("hook-start" \/\* HookStart \*\/, handleHookStartHistory\);/m,
        ""
    );
    newContent = newContent.replace(
        /\n\s*coreEvents\.off\("hook-start" \/\* HookStart \*\/, handleHookStartHistory\);/m,
        ""
    );

    if (newContent === originalContent) {
        console.log(`  No changes needed for ${fileName}.`);
        continue;
    }

    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) {
        try {
            fs.copyFileSync(filePath, backupPath);
        } catch (e) {
            console.error(`  Failed to create backup ${backupPath}: ${e.message}`);
            console.error("  Please run this script with appropriate permissions (e.g., sudo).");
            failedCount++;
            continue;
        }
    }

    try {
        fs.writeFileSync(filePath, newContent, "utf8");
        patchedCount++;
        console.log(`  Successfully patched ${fileName} (deferred hook render order).`);
    } catch (e) {
        console.error(`  Failed to write patched content to ${fileName}: ${e.message}`);
        console.error("  Please run this script with appropriate permissions (e.g., sudo).");
        failedCount++;
    }
}

const chunkFiles = fs.readdirSync(bundleDir)
    .filter(file => /^chunk-.*\.js$/.test(file))
    .map(file => path.join(bundleDir, file));

for (const filePath of chunkFiles) {
    let content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(oldHackMarker) && !content.includes("eventName !== \"AfterAgent\"")) {
        continue;
    }

    const fileName = path.basename(filePath);
    console.log(`Removing old content-injection hook patch from ${fileName}...`);
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) {
        try {
            fs.copyFileSync(filePath, backupPath);
        } catch (e) {
            console.error(`  Failed to create backup ${backupPath}: ${e.message}`);
            console.error("  Please run this script with appropriate permissions (e.g., sudo).");
            failedCount++;
            continue;
        }
    }

    const cleaned = content
        .replace(/\/\/\s--- StopHook Patch Start ---[\s\S]*?\/\/\s--- StopHook Patch End ---/g, "")
        .replace(
            /if \(eventName !== "AfterAgent" && result2\.output\?\.systemMessage && result2\.outputFormat === "json"\) \{/g,
            'if (result2.output?.systemMessage && result2.outputFormat === "json") {'
        );

    if (cleaned === content) {
        console.log(`  No old chunk patch found in ${fileName}.`);
        continue;
    }

    try {
        fs.writeFileSync(filePath, cleaned, "utf8");
        patchedCount++;
    } catch (e) {
        console.error(`  Failed to clean ${fileName}: ${e.message}`);
        console.error("  Please run this script with appropriate permissions (e.g., sudo).");
        failedCount++;
    }
}

if (failedCount > 0) {
    console.error(`\nFailed to apply ${failedCount} patch operation(s). Try: sudo node scripts/patch-gemini-stophook.mjs`);
    process.exit(1);
}

console.log(`\nDone. Patched ${patchedCount} file(s). Restart your gemini session to apply changes.`);
