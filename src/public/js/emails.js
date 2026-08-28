/**
 * Email download management module
 */

import { getCurrentFolderHandle } from './folders.js';
import { analyzeEmailFile } from './folders.js';
import { resolveUserFolderHandle } from './folderResolver.js';
import { toastSuccess, toastWarning, toastError, toastInfo, showConfirmModal } from './toast.js';
import {
  hideLoadingOverlay,
  updateLoadingOverlay,
  showEmailDownloadAnimation,
  updateEmailDownloadCounter,
  showDownloadSuccessAnimation,
  restoreStandardLoadingOverlay,
} from './ui.js';
import { getCurrentFilters } from './filterUI.js';
import { isDemoMode, getDemoHtmlFileHandle } from './demo.js';

// ─── Inline progress bar (non-bloquant) ─────────────────────────────────────

function showInlineProgress() {
  const bar = document.getElementById('downloadProgressBar');
  if (bar) bar.style.display = 'block';
}

function updateInlineProgress(received, total, filtered = 0) {
  const fill = document.getElementById('downloadProgressFill');
  const text = document.getElementById('downloadProgressText');
  if (!fill || !text) return;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  fill.style.width = `${pct}%`;
  const filteredText = filtered > 0 ? ` (${filtered} filtered)` : '';
  text.textContent = `Download: ${received}/${total} emails${filteredText} (${pct}%)`;
}

function hideInlineProgress() {
  const bar = document.getElementById('downloadProgressBar');
  if (bar) bar.style.display = 'none';
}

/**
 * Returns the HTML companion filename for a given provider.
 */
function getHtmlFileName(provider) {
  return provider === 'gmail' ? 'gmail_emails_html.jsonl' : 'outlook_emails_html.jsonl';
}

// ─── Filter comparison (order-insensitive for arrays) ────────────────────────

/**
 * Normalises a filters object for stable comparison:
 * - Sorts the arrays (blacklistedSenders, blacklistedKeywords)
 * - Removes fields that have their default value and did not exist before
 *   (backward compat: avoids a re-download when a new field is added)
 */
function normalizeFiltersForComparison(filters) {
  if (!filters) return null;
  const copy = { ...filters };
  // Sort the arrays so their order does not affect the comparison
  if (copy.blacklistedSenders) copy.blacklistedSenders = [...copy.blacklistedSenders].sort();
  if (copy.blacklistedKeywords) copy.blacklistedKeywords = [...copy.blacklistedKeywords].sort();
  if (copy.notificationKeywords) copy.notificationKeywords = [...copy.notificationKeywords].sort();
  if (copy.promotionalKeywords) copy.promotionalKeywords = [...copy.promotionalKeywords].sort();
  // Remove fields that do not affect the downloaded content
  // (autoExcludeRepetitive only affects the current filtering, not the result of a re-download)
  delete copy.autoExcludeRepetitive;
  delete copy.blacklistedSubjects;
  // customAfterDate: a date change should indeed trigger a re-download
  // useCustomAfterDate: same
  return copy;
}

// ─── Sync metadata ────────────────────────────────────────────────────────

/**
 * Reads the sync metadata file from the user folder.
 * Returns null if the file does not exist (= first download).
 * @param {FileSystemDirectoryHandle} userFolderHandle - EmailWorkflow/{userId}/ folder
 * @param {string} provider - "gmail" or "outlook"
 * @returns {Object|null}
 */
export async function readSyncMetadata(userFolderHandle, provider) {
  const metaFileName = `${provider}_sync_metadata.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(metaFileName);
    const file = await fileHandle.getFile();
    const content = await file.text();
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

/**
 * Writes (or overwrites) the sync metadata file.
 * @param {FileSystemDirectoryHandle} userFolderHandle - EmailWorkflow/{userId}/ folder
 * @param {string} provider - "gmail" or "outlook"
 * @param {Object} metadata - Data to store
 */
export async function writeSyncMetadata(userFolderHandle, provider, metadata) {
  const metaFileName = `${provider}_sync_metadata.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(metaFileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(metadata, null, 2));
    await writable.close();
    console.log(`✅ Sync metadata written to ${metaFileName}`);
  } catch (e) {
    console.error(`❌ Error writing sync metadata:`, e);
  }
}

// ─── Email download ────────────────────────────────────────────────────────

/**
 * Downloads a list of emails and writes them to the JSONL file.
 * @param {Array} availableMessageIds - IDs of the messages to download
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @param {Object} options
 * @param {boolean} options.appendMode - true = append to existing emails, false = full rewrite
 * @param {boolean} options.silent - true = no confirmation dialog (automatic sync)
 * @param {number} options.existingEmailCount - Number of emails already present (for the total in the metadata)
 */
export async function downloadEmails(availableMessageIds, provider, userId, options = {}) {
  const {
    appendMode = false,
    silent = false,
    existingEmailCount = 0,
    onMilestone = null,
    milestoneInterval = 1000,
  } = options;

  if (!availableMessageIds.length) {
    if (!silent) toastInfo('No new emails to download.');
    return;
  }

  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) {
    if (!silent) toastWarning('Please choose a save folder first.');
    return;
  }

  if (!silent) {
    const confirmed = await showConfirmModal({
      title: appendMode ? 'Add emails' : 'Download emails',
      message: appendMode
        ? `Add <strong>${availableMessageIds.length}</strong> new emails to your collection?<br><br>Existing emails will be kept.`
        : `Download <strong>${availableMessageIds.length}</strong> emails in batches of 500?<br><br>This operation may take several minutes.`,
      html: true,
      type: 'info',
      confirmText: appendMode ? 'Add' : 'Download',
    });
    if (!confirmed) return;
  }

  // Declared outside the try so they stay accessible in the catch (closing
  // the writables on the error path — otherwise `writable` leaked on some
  // paths while `htmlWritable` was closed).
  let writable = null;
  let htmlWritable = null;

  try {
    // Get the current filters
    const filters = getCurrentFilters();

    // Show the download animation with flying emails
    showEmailDownloadAnimation(availableMessageIds.length);
    showInlineProgress();

    // Show the download status
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = `📦 Downloading ${availableMessageIds.length} emails...`;

    // Initialise the counter at 0
    updateEmailDownloadCounter(0, availableMessageIds.length);

    // Use fetch to send the data (POST) and receive the SSE stream
    // Dynamic URL based on the provider — do not hardcode /gmail/download-chunks
    console.log(`📡 Download chunks — provider: ${provider}, URL: /${provider}/download-chunks`);
    const response = await fetch(`/${provider}/download-chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messageIds: availableMessageIds,
        chunkSize: 500,
        filters: filters,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    // Tolerant resolution of the data folder (creates the default structure if missing).
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: true,
    });

    // Determine the file name based on the provider
    let fileName = 'emails.jsonl';
    if (provider === 'gmail') fileName = 'gmail_emails.jsonl';
    else if (provider === 'outlook') fileName = 'outlook_emails.jsonl';

    // Prepare the write based on the mode (writable is declared above)
    let tempFileHandle = null;
    const tempFileName = `${fileName}.temp`;

    if (appendMode) {
      // Append mode: open the existing file and seek to the end
      const finalFileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
      const existingFile = await finalFileHandle.getFile();
      writable = await finalFileHandle.createWritable({ keepExistingData: true });
      await writable.seek(existingFile.size);
      console.log(
        `📎 Append mode: seeking to the end of the file (${existingFile.size} existing bytes)`
      );
    } else {
      // Overwrite mode: write to a temp file then swap it in
      tempFileHandle = await userFolderHandle.getFileHandle(tempFileName, { create: true });
      writable = await tempFileHandle.createWritable();
    }

    // HTML companion file — same mode (append or overwrite) as main file
    // (htmlWritable is declared above so it is accessible in the catch)
    let tempHtmlFileHandle = null;
    const htmlFileName = getHtmlFileName(provider);
    const tempHtmlFileName = `${htmlFileName}.temp`;

    if (appendMode) {
      const htmlFileHandle = await userFolderHandle.getFileHandle(htmlFileName, { create: true });
      const existingHtmlFile = await htmlFileHandle.getFile();
      htmlWritable = await htmlFileHandle.createWritable({ keepExistingData: true });
      await htmlWritable.seek(existingHtmlFile.size);
    } else {
      tempHtmlFileHandle = await userFolderHandle.getFileHandle(tempHtmlFileName, { create: true });
      htmlWritable = await tempHtmlFileHandle.createWritable();
    }

    // Read the SSE stream and write directly chunk by chunk
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let downloadResult = null;
    let emailsWritten = 0;
    let maxInternalDate = null; // For the sync metadata
    const accumulatedEmails = [];
    let lastMilestoneCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process the SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));

            if (data.type === 'start') {
              console.log(`🚀 Starting: ${data.totalEmails} emails in ${data.totalChunks} chunks`);
            } else if (data.type === 'emails') {
              // Write directly chunk by chunk without accumulating in memory
              for (const email of data.emails) {
                // Write bodyHtml to companion file
                if (email.bodyHtml) {
                  await htmlWritable.write(
                    JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n'
                  );
                }
                // Write main email without bodyHtml and unused fields
                const {
                  bodyHtml: _bodyHtml,
                  sizeEstimate: _sizeEstimate,
                  historyId: _historyId,
                  labelIds: _labelIds,
                  ...emailWithoutHtml
                } = email;
                await writable.write(JSON.stringify(emailWithoutHtml) + '\n');
                emailsWritten++;
                // Track the max date for the sync metadata
                if (email.internalDate) {
                  const ts = parseInt(email.internalDate);
                  if (!maxInternalDate || ts > maxInternalDate) maxInternalDate = ts;
                }
              }
              console.log(
                `💾 ${data.emails.length} emails written to disk (total: ${emailsWritten} written)`
              );

              // Accumulate for progressive analysis
              if (onMilestone) {
                for (const email of data.emails) {
                  accumulatedEmails.push(email);
                }
                if (accumulatedEmails.length - lastMilestoneCount >= milestoneInterval) {
                  lastMilestoneCount = accumulatedEmails.length;
                  try {
                    onMilestone([...accumulatedEmails], {
                      isFinal: false,
                      totalReceived: accumulatedEmails.length,
                      totalRequested: availableMessageIds.length,
                    });
                  } catch (e) {
                    console.warn('⚠️ Error in onMilestone:', e);
                  }
                }
              }

              // Immediate visual update while writing
              const progress = (emailsWritten / availableMessageIds.length) * 100;
              updateLoadingOverlay(`Writing to disk... ${emailsWritten} emails saved`, progress);
            } else if (data.type === 'progress') {
              // Real-time update on each chunk
              const chunkInfo = `Chunk ${data.chunkIndex}/${data.totalChunks}`;

              // Update the overlay with the animated counter
              updateEmailDownloadCounter(data.totalRetrieved, data.totalRequested, chunkInfo);

              // Update the status with filter info
              const filteredInfo =
                data.totalFiltered > 0 ? ` (${data.totalFiltered} filtered)` : '';
              statusDiv.textContent = `📦 ${data.totalRetrieved} / ${data.totalRequested} emails${filteredInfo} - ${chunkInfo}`;

              // Debug log
              console.log(
                `📊 Progress: ${data.totalRetrieved}/${data.totalRequested} (${data.percentage}%) - ${chunkInfo}${filteredInfo}`
              );
              updateInlineProgress(data.totalRetrieved, data.totalRequested, data.totalFiltered);
            } else if (data.type === 'complete') {
              downloadResult = data;
              // Final milestone
              if (onMilestone && accumulatedEmails.length > 0) {
                try {
                  onMilestone([...accumulatedEmails], {
                    isFinal: true,
                    totalReceived: accumulatedEmails.length,
                    totalRequested: availableMessageIds.length,
                  });
                } catch (e) {
                  console.warn('⚠️ Error in onMilestone (final):', e);
                }
              }
              console.log(`\n📊 ═══ DOWNLOAD SUMMARY ═══`);
              console.log(`   Emails requested: ${data.totalRequested}`);
              console.log(`   Emails kept: ${data.totalRetrieved}`);
              console.log(
                `   Emails filtered (rules): ${data.totalFiltered - (data.totalAutoExcluded || 0)}`
              );
              console.log(`   Emails auto-excluded: ${data.totalAutoExcluded || 0}`);
              if (data.autoExcludedSenders && data.autoExcludedSenders.length > 0) {
                console.log(`   Auto-excluded senders:`);
                data.autoExcludedSenders.forEach((s) => console.log(`     → ${s}`));
              }
              if (data.topSenders && data.topSenders.length > 0) {
                console.log(`   Top senders (diagnostic):`);
                data.topSenders.forEach((s) => {
                  console.log(
                    `     ${s.status.padEnd(12)} | ${String(s.count).padStart(3)} mails | ${s.sender}`
                  );
                  if (s.normalized) {
                    console.log(`       original subjects: ${JSON.stringify(s.subjects)}`);
                    console.log(`       normalised subjects: ${JSON.stringify(s.normalized)}`);
                    console.log(
                      `       match: ${s.maxMatch}/5 | avg body: ${s.avgBody} | body lengths: [${s.bodyLengths}]`
                    );
                  }
                });
              }
              console.log(`═══════════════════════════════\n`);
              // Persist the auto-excluded senders to the blocklist
              if (data.autoExcludedSenders && data.autoExcludedSenders.length > 0) {
                try {
                  const liveFilters = getCurrentFilters();
                  if (liveFilters) {
                    if (!liveFilters.blacklistedSenders) liveFilters.blacklistedSenders = [];
                    const existing = new Set(
                      liveFilters.blacklistedSenders.map((s) => s.toLowerCase())
                    );
                    let added = 0;
                    for (const sender of data.autoExcludedSenders) {
                      if (!existing.has(sender.toLowerCase())) {
                        liveFilters.blacklistedSenders.push(sender);
                        added++;
                      }
                    }
                    if (added > 0) {
                      const { saveFilters } = await import('./emailFilters.js');
                      const { updateCurrentFilters } = await import('./filterUI.js');
                      await saveFilters(liveFilters);
                      updateCurrentFilters(liveFilters); // sync in memory
                      console.log(
                        `✅ ${added} sender(s) added to the blocklist for future downloads`
                      );
                    }
                  }
                } catch (e) {
                  console.warn('⚠️ Unable to persist the auto-excluded senders:', e);
                }
              }
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          }
        }
      }
    } finally {
      await writable.close();
      if (htmlWritable) await htmlWritable.close();
      console.log(`💾 File closed: ${emailsWritten} emails written`);
    }

    if (!downloadResult || !downloadResult.success) {
      throw new Error(downloadResult?.message || 'Download error');
    }

    const filteredText =
      downloadResult.totalFiltered > 0 ? ` (${downloadResult.totalFiltered} filtered)` : '';
    const autoText =
      downloadResult.totalAutoExcluded > 0
        ? ` (${downloadResult.totalAutoExcluded} auto-excluded)`
        : '';
    statusDiv.textContent = `✅ ${downloadResult.totalRetrieved} emails downloaded${filteredText}${autoText}`;

    if (!appendMode) {
      // Overwrite mode: copy the temp file to the final file then delete the temp file
      console.log(`📧 ${emailsWritten} emails written to ${tempFileName}`);

      try {
        await userFolderHandle.removeEntry(fileName);
        console.log(`🗑️ Old file ${fileName} deleted`);
      } catch (e) {
        console.log(`No old file to delete`);
      }

      const finalFileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
      const finalWritable = await finalFileHandle.createWritable();
      const tempFile = await tempFileHandle.getFile();
      const tempStream = tempFile.stream();
      const tempReader = tempStream.getReader();

      while (true) {
        const { done, value } = await tempReader.read();
        if (done) break;
        await finalWritable.write(value);
      }

      await finalWritable.close();
      console.log(`✅ ${emailsWritten} emails copied to ${fileName}`);

      try {
        await userFolderHandle.removeEntry(tempFileName);
        console.log(`🗑️ Temp file ${tempFileName} deleted`);
      } catch (e) {
        console.log(`Unable to delete ${tempFileName}`);
      }
    } else {
      console.log(`✅ ${emailsWritten} emails added to ${fileName} (append mode)`);
    }

    // Also swap HTML companion file in overwrite mode
    if (!appendMode && tempHtmlFileHandle) {
      try {
        await userFolderHandle.removeEntry(htmlFileName);
      } catch (e) {
        console.log('No old HTML file to delete');
      }

      const finalHtmlHandle = await userFolderHandle.getFileHandle(htmlFileName, { create: true });
      const finalHtmlWritable = await finalHtmlHandle.createWritable();
      const tempHtmlFile = await tempHtmlFileHandle.getFile();
      const tempHtmlReader = tempHtmlFile.stream().getReader();

      while (true) {
        const { done, value } = await tempHtmlReader.read();
        if (done) break;
        await finalHtmlWritable.write(value);
      }

      await finalHtmlWritable.close();

      try {
        await userFolderHandle.removeEntry(tempHtmlFileName);
      } catch (e) {
        console.log('Unable to delete the temp HTML file');
      }
    }

    // Write the sync metadata
    const filtersToSave = getCurrentFilters();
    const metadataToWrite = {
      lastSyncDate: new Date().toISOString(),
      lastInternalDate: maxInternalDate ? String(maxInternalDate) : null,
      totalEmails: existingEmailCount + emailsWritten,
      filtersUsed: filtersToSave,
      provider: provider,
    };
    await writeSyncMetadata(userFolderHandle, provider, metadataToWrite);
    console.log(`💾 Sync metadata written:`);
    console.log(`   ├─ lastSyncDate: ${metadataToWrite.lastSyncDate}`);
    console.log(`   ├─ totalEmails: ${metadataToWrite.totalEmails}`);
    console.log(
      `   ├─ blacklistedSenders in metadata: ${(filtersToSave?.blacklistedSenders || []).length} entries`
    );
    console.log(`   └─ autoExcludeRepetitive: ${filtersToSave?.autoExcludeRepetitive}`);

    // Show the success animation
    showDownloadSuccessAnimation(emailsWritten);

    const actionText = appendMode ? 'added' : 'saved';
    const finalMessage =
      `${emailsWritten} emails ${actionText} to\n` +
      `${currentFolderHandle.name}/EmailWorkflow/${userId}/${fileName}`;

    setTimeout(() => {
      hideLoadingOverlay();
      hideInlineProgress();
      restoreStandardLoadingOverlay();
      if (!silent) toastSuccess(finalMessage, 6000);
    }, 2000);
  } catch (e) {
    // Close both writables if still open (close() on an already-closed
    // writable rejects → each close is isolated in its own try/catch).
    try {
      if (writable) await writable.close();
    } catch (_) {}
    try {
      if (htmlWritable) await htmlWritable.close();
    } catch (_) {}
    hideInlineProgress();
    restoreStandardLoadingOverlay();
    hideLoadingOverlay();
    if (!silent) toastError('Error while saving: ' + e.message);
    else console.error('Download error (silent mode):', e.message);
  }
}

// ─── Incremental sync ────────────────────────────────────────────────────────

/**
 * Creates the gmail_sync_metadata.json file from an already existing JSONL,
 * without needing to re-download the emails.
 * Called automatically by syncEmails() if the JSONL exists but the metadata does not.
 *
 * @param {FileSystemDirectoryHandle} userFolderHandle - EmailWorkflow/{userId}/ folder
 * @param {string} provider - "gmail" or "outlook"
 * @param {Object} currentFilters - Currently active filters
 * @returns {boolean} true if the bootstrap succeeded, false if the JSONL does not exist
 */
async function bootstrapSyncMetadata(userFolderHandle, provider, currentFilters) {
  const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';

  try {
    const fileHandle = await userFolderHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();

    if (file.size === 0) return false;

    console.log(`🔧 Bootstrap metadata depuis ${fileName} (${Math.round(file.size / 1024)} Ko)...`);

    // Read the file in streaming mode to find the max internalDate without loading it all
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';
    let maxInternalDate = null;
    let totalEmails = 0;

    for await (const chunk of stream) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const email = JSON.parse(line);
          totalEmails++;
          if (email.internalDate) {
            const ts = parseInt(email.internalDate);
            if (!maxInternalDate || ts > maxInternalDate) maxInternalDate = ts;
          }
        } catch (e) {
          // Malformed line, ignored
        }
      }
    }

    // Process the last line
    if (buffer.trim()) {
      try {
        const email = JSON.parse(buffer);
        totalEmails++;
        if (email.internalDate) {
          const ts = parseInt(email.internalDate);
          if (!maxInternalDate || ts > maxInternalDate) maxInternalDate = ts;
        }
      } catch (e) {}
    }

    if (totalEmails === 0) return false;

    // Write the metadata
    await writeSyncMetadata(userFolderHandle, provider, {
      lastSyncDate: new Date().toISOString(),
      lastInternalDate: maxInternalDate ? String(maxInternalDate) : null,
      totalEmails: totalEmails,
      filtersUsed: currentFilters,
      provider: provider,
      bootstrapped: true, // Marker to know the metadata was created from an existing JSONL
    });

    console.log(
      `✅ Bootstrap complete: ${totalEmails} emails indexed, last email: ${maxInternalDate ? new Date(maxInternalDate).toISOString() : 'unknown'}`
    );
    return true;
  } catch (e) {
    // The JSONL file does not exist
    return false;
  }
}

/**
 * Orchestrates the incremental sync of emails.
 * - If no metadata: first download (existing behaviour).
 * - If filters changed: full re-download (strict mode).
 * - Otherwise: download only the more recent emails + deduplication.
 *
 * Called automatically on page load AND by the "Update" button.
 *
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId   - User email
 * @returns {boolean} true if a sync was performed, false if there was nothing to do
 */
export async function syncEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) {
    console.log('📁 No folder selected, sync cancelled');
    return false;
  }

  try {
    // Tolerant resolution of the data folder.
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) {
      // The folder does not exist yet: a manual first download is required
      console.log('📁 Data folder does not exist — first download required');
      return false;
    }

    // Read the metadata from the last sync
    let metadata = await readSyncMetadata(userFolderHandle, provider);
    const currentFilters = getCurrentFilters();

    // No metadata but a JSONL file already exists → automatic bootstrap
    if (!metadata) {
      const bootstrapped = await bootstrapSyncMetadata(userFolderHandle, provider, currentFilters);
      if (bootstrapped) {
        metadata = await readSyncMetadata(userFolderHandle, provider);
        console.log('🔧 Metadata created from the existing JSONL — incremental sync enabled');
      } else {
        // Neither metadata nor JSONL file: a manual first download is required
        console.log('📋 No email file found — first download required');
        return false;
      }
    }

    const normalizedSaved = normalizeFiltersForComparison(metadata.filtersUsed);
    const normalizedCurrent = normalizeFiltersForComparison(currentFilters);
    const filtersChanged = JSON.stringify(normalizedSaved) !== JSON.stringify(normalizedCurrent);

    console.log(`🔍 Comparing filters for sync:`);
    console.log(
      `   ├─ blacklistedSenders (metadata): ${(metadata.filtersUsed?.blacklistedSenders || []).length} entries`
    );
    console.log(
      `   ├─ blacklistedSenders (current): ${(currentFilters?.blacklistedSenders || []).length} entries`
    );
    console.log(`   └─ filtersChanged: ${filtersChanged}`);

    let afterDate = null;
    let appendMode = false;

    if (filtersChanged) {
      console.log('🔄 Filters changed since the last sync → full re-download');
      afterDate = null;
      appendMode = false;
    } else {
      afterDate = metadata.lastInternalDate;
      appendMode = true;
      if (afterDate) {
        console.log(`📅 Incremental sync since: ${new Date(parseInt(afterDate)).toISOString()}`);
      }
    }

    // If a custom date is set and we do not have a more recent date,
    // use it as the lower bound
    if (currentFilters && currentFilters.useCustomAfterDate && currentFilters.customAfterDate) {
      const customMs = String(new Date(currentFilters.customAfterDate).getTime());
      if (!afterDate || parseInt(customMs) > parseInt(afterDate)) {
        afterDate = customMs;
        console.log(`📅 Custom date applied: ${currentFilters.customAfterDate}`);
      }
    }

    // Get the IDs from the right provider (with a date filter if incremental)
    // Dynamic URL — do not hardcode /gmail/emails
    const params = new URLSearchParams();
    if (currentFilters) params.set('filters', JSON.stringify(currentFilters));
    if (afterDate) params.set('afterDate', afterDate);

    console.log(`📡 syncEmails — provider: ${provider}, URL: /${provider}/emails`);
    const response = await fetch(`/${provider}/emails?${params.toString()}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.requiresLogout) {
        console.warn('⚠️ Expired token — sync cancelled');
        return false;
      }
      throw new Error(`Error retrieving IDs: ${response.status}`);
    }

    const emailData = await response.json();
    let messageIds = emailData.messageIds || [];

    if (messageIds.length === 0) {
      console.log('✅ No new emails — collection up to date');
      return false;
    }

    // Deduplication: remove IDs already present in the JSONL
    if (appendMode) {
      const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
      let existingIds = new Set();

      try {
        const fileHandle = await userFolderHandle.getFileHandle(fileName);
        const fileInfo = await analyzeEmailFile(fileHandle);
        existingIds = fileInfo.emailIds || new Set();
        console.log(`📊 ${existingIds.size} existing emails in the file`);
      } catch (e) {
        // JSONL file missing: all IDs are new
      }

      const countBefore = messageIds.length;
      messageIds = messageIds.filter((m) => !existingIds.has(m.id));
      console.log(
        `🔍 Deduplication: ${countBefore} IDs retrieved → ${messageIds.length} genuinely new`
      );

      if (messageIds.length === 0) {
        console.log('✅ All recent emails are already synced');
        return false;
      }
    }

    // Start the download (silent, append or overwrite mode)
    await downloadEmails(messageIds, provider, userId, {
      appendMode: appendMode,
      silent: true,
      existingEmailCount: appendMode ? metadata?.totalEmails || 0 : 0,
    });

    return true;
  } catch (error) {
    console.error('❌ Error syncing emails:', error);
    return false;
  }
}

// ─── Lightweight polling ("new emails" badge) ─────────────────────────────────

let _pollingInterval = null;

/**
 * Silently checks the number of new emails available
 * and updates the "Update" button badge.
 * Performs no download.
 *
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId   - User email
 */
export async function checkForNewEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return;

  try {
    // Access the user folder
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) throw new Error('Data folder not found');

    const metadata = await readSyncMetadata(userFolderHandle, provider);
    if (!metadata || !metadata.lastInternalDate) return;

    // Lightweight call: just a count, no content
    const params = new URLSearchParams({ afterDate: metadata.lastInternalDate });
    if (metadata.filtersUsed) params.set('filters', JSON.stringify(metadata.filtersUsed));

    const response = await fetch(`/${provider}/count?${params.toString()}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.requiresLogout) console.warn('⚠️ Expired token — polling cancelled');
      return;
    }

    const { newCount } = await response.json();
    updateNewEmailsBadge(newCount);

    if (newCount > 0) {
      console.log(`📬 ${newCount} new emails available`);
    }
  } catch (e) {
    // Silent: folder missing, no metadata, etc.
  }
}

/**
 * Updates the "Update" button badge.
 * @param {number} count - Number of new emails (0 = none)
 */
export function updateNewEmailsBadge(count) {
  const btn = document.getElementById('updateEmailsBtn');
  const badge = document.getElementById('newEmailCountBadge');
  if (!btn || !badge) return;

  badge.textContent = count > 0 ? count : '0';

  if (count > 0) {
    btn.classList.add('has-updates');
    btn.title = `${count} new emails available`;
  } else {
    btn.classList.remove('has-updates');
    btn.title = '';
  }
}

/**
 * Starts polling every `intervalMs` ms (default: 5 min).
 * Runs a first check immediately.
 *
 * @param {string} provider
 * @param {string} userId
 * @param {number} intervalMs - Interval in milliseconds (default: 300,000 = 5 min)
 */
export function startEmailPolling(provider, userId, intervalMs = 5 * 60 * 1000) {
  stopEmailPolling();

  // First check immediately on start
  checkForNewEmails(provider, userId);

  _pollingInterval = setInterval(() => checkForNewEmails(provider, userId), intervalMs);
  console.log(`🔄 Polling started (every ${intervalMs / 1000}s)`);
}

/**
 * Stops the current polling.
 */
export function stopEmailPolling() {
  if (_pollingInterval) {
    clearInterval(_pollingInterval);
    _pollingInterval = null;
  }
}

/**
 * Removes from the JSONL file every email whose (cleaned) subject matches.
 * Atomic rewrite: read → filter → write to a temp file → swap.
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @param {string} subjectToRemove - Subject to remove (already cleaned, without Re:/Fwd:)
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupExcludedSubjectFromJSONL(provider, userId, subjectToRemove) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) throw new Error('No folder selected');

  const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
    create: false,
  });
  if (!userFolderHandle) throw new Error('Data folder not found');

  const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
  const tempFileName = `${fileName}.cleanup.temp`;

  const fileHandle = await userFolderHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();

  // Write filtered emails to temp file
  const tempFileHandle = await userFolderHandle.getFileHandle(tempFileName, { create: true });
  const writable = await tempFileHandle.createWritable();

  const stream = file.stream();
  const textDecoder = new TextDecoder();
  let buffer = '';
  let removed = 0;
  let kept = 0;
  const removedIds = new Set();

  for await (const chunk of stream) {
    buffer += textDecoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const email = JSON.parse(line);
        const cleanSubject = (email.subject || '')
          .replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '')
          .trim();
        if (cleanSubject === subjectToRemove) {
          removedIds.add(email.id);
          removed++;
        } else {
          await writable.write(line + '\n');
          kept++;
        }
      } catch (e) {
        // Keep malformed lines as-is
        await writable.write(line + '\n');
        kept++;
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const email = JSON.parse(buffer);
      const cleanSubject = (email.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
      if (cleanSubject === subjectToRemove) {
        removedIds.add(email.id);
        removed++;
      } else {
        await writable.write(buffer + '\n');
        kept++;
      }
    } catch (e) {
      await writable.write(buffer + '\n');
      kept++;
    }
  }

  await writable.close();

  // Atomic swap: delete original, rename temp
  try {
    await userFolderHandle.removeEntry(fileName);
  } catch (e) {
    console.warn('⚠️ Unable to delete the old file:', e);
  }

  // Copy temp to final (rename not available in File System Access API)
  const finalFileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
  const finalWritable = await finalFileHandle.createWritable();
  const tempFile = await tempFileHandle.getFile();
  const tempReader = tempFile.stream().getReader();

  while (true) {
    const { done, value } = await tempReader.read();
    if (done) break;
    await finalWritable.write(value);
  }

  await finalWritable.close();

  // Clean up temp
  try {
    await userFolderHandle.removeEntry(tempFileName);
  } catch (e) {
    console.log('Unable to delete the temp file');
  }

  // Also clean HTML companion file
  if (removedIds.size > 0) {
    const htmlFileName = getHtmlFileName(provider);
    try {
      const htmlFileHandle = await userFolderHandle.getFileHandle(htmlFileName);
      const htmlFile = await htmlFileHandle.getFile();

      const tempHtmlName = `${htmlFileName}.cleanup.temp`;
      const tempHtmlHandle = await userFolderHandle.getFileHandle(tempHtmlName, { create: true });
      const htmlWritable = await tempHtmlHandle.createWritable();

      const htmlStream = htmlFile.stream();
      const htmlDecoder = new TextDecoder();
      let htmlBuffer = '';

      for await (const chunk of htmlStream) {
        htmlBuffer += htmlDecoder.decode(chunk, { stream: true });
        const htmlLines = htmlBuffer.split('\n');
        htmlBuffer = htmlLines.pop() || '';

        for (const line of htmlLines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (!removedIds.has(entry.id)) {
              await htmlWritable.write(line + '\n');
            }
          } catch (e) {
            await htmlWritable.write(line + '\n');
          }
        }
      }

      if (htmlBuffer.trim()) {
        try {
          const entry = JSON.parse(htmlBuffer);
          if (!removedIds.has(entry.id)) {
            await htmlWritable.write(htmlBuffer + '\n');
          }
        } catch (e) {
          await htmlWritable.write(htmlBuffer + '\n');
        }
      }

      await htmlWritable.close();

      // Atomic swap
      await userFolderHandle.removeEntry(htmlFileName);
      const finalHtml = await userFolderHandle.getFileHandle(htmlFileName, { create: true });
      const finalHtmlWritable = await finalHtml.createWritable();
      const tmpHtmlFile = await tempHtmlHandle.getFile();
      const tmpReader = tmpHtmlFile.stream().getReader();
      while (true) {
        const { done, value } = await tmpReader.read();
        if (done) break;
        await finalHtmlWritable.write(value);
      }
      await finalHtmlWritable.close();

      try {
        await userFolderHandle.removeEntry(tempHtmlName);
      } catch (e) {}
      console.log(`🗑️ HTML file cleaned: ${removedIds.size} entries removed`);
    } catch (e) {
      console.log('ℹ️ No HTML companion file to clean');
    }
  }

  // Update sync metadata
  const metadata = await readSyncMetadata(userFolderHandle, provider);
  if (metadata) {
    metadata.totalEmails = kept;
    await writeSyncMetadata(userFolderHandle, provider, metadata);
  }

  console.log(
    `🗑️ JSONL clean-up: ${removed} emails removed, ${kept} kept for the subject "${subjectToRemove}"`
  );
  return { removed, kept };
}

/**
 * Batch version: removes several subjects from the JSONL (and its HTML companion)
 * in A SINGLE pass over each file. Much faster than calling
 * cleanupExcludedSubjectFromJSONL in a loop for N subjects (which would read the
 * file N times).
 *
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @param {string[]} subjectsToRemove - Subjects to remove (already cleaned, without Re:/Fwd:)
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupExcludedSubjectsFromJSONL(provider, userId, subjectsToRemove) {
  if (!subjectsToRemove || subjectsToRemove.length === 0) {
    return { removed: 0, kept: 0 };
  }

  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) throw new Error('No folder selected');

  const excludeSet = new Set(subjectsToRemove);
  const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
    create: false,
  });
  if (!userFolderHandle) throw new Error('Data folder not found');

  const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
  const tempFileName = `${fileName}.cleanup.temp`;

  const fileHandle = await userFolderHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();

  const tempFileHandle = await userFolderHandle.getFileHandle(tempFileName, { create: true });
  const writable = await tempFileHandle.createWritable();

  const stream = file.stream();
  const textDecoder = new TextDecoder();
  let buffer = '';
  let removed = 0;
  let kept = 0;
  const removedIds = new Set();

  const processLine = async (line) => {
    if (!line.trim()) return;
    try {
      const email = JSON.parse(line);
      const cleanSubject = (email.subject || '').replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '').trim();
      if (excludeSet.has(cleanSubject)) {
        removedIds.add(email.id);
        removed++;
        return;
      }
      await writable.write(line + '\n');
      kept++;
    } catch (e) {
      await writable.write(line + '\n');
      kept++;
    }
  };

  for await (const chunk of stream) {
    buffer += textDecoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) await processLine(line);
  }
  if (buffer.trim()) await processLine(buffer);

  await writable.close();

  // Atomic swap of the main JSONL
  try {
    await userFolderHandle.removeEntry(fileName);
  } catch (e) {
    console.warn('⚠️ Unable to delete the old file:', e);
  }

  const finalFileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
  const finalWritable = await finalFileHandle.createWritable();
  const tempFile = await tempFileHandle.getFile();
  const tempReader = tempFile.stream().getReader();
  while (true) {
    const { done, value } = await tempReader.read();
    if (done) break;
    await finalWritable.write(value);
  }
  await finalWritable.close();

  try {
    await userFolderHandle.removeEntry(tempFileName);
  } catch (e) {}

  // HTML companion — also A SINGLE pass
  if (removedIds.size > 0) {
    const htmlFileName = getHtmlFileName(provider);
    try {
      const htmlFileHandle = await userFolderHandle.getFileHandle(htmlFileName);
      const htmlFile = await htmlFileHandle.getFile();

      const tempHtmlName = `${htmlFileName}.cleanup.temp`;
      const tempHtmlHandle = await userFolderHandle.getFileHandle(tempHtmlName, { create: true });
      const htmlWritable = await tempHtmlHandle.createWritable();

      const htmlStream = htmlFile.stream();
      const htmlDecoder = new TextDecoder();
      let htmlBuffer = '';

      const processHtmlLine = async (line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          if (!removedIds.has(entry.id)) {
            await htmlWritable.write(line + '\n');
          }
        } catch (e) {
          await htmlWritable.write(line + '\n');
        }
      };

      for await (const chunk of htmlStream) {
        htmlBuffer += htmlDecoder.decode(chunk, { stream: true });
        const htmlLines = htmlBuffer.split('\n');
        htmlBuffer = htmlLines.pop() || '';
        for (const line of htmlLines) await processHtmlLine(line);
      }
      if (htmlBuffer.trim()) await processHtmlLine(htmlBuffer);

      await htmlWritable.close();

      await userFolderHandle.removeEntry(htmlFileName);
      const finalHtml = await userFolderHandle.getFileHandle(htmlFileName, { create: true });
      const finalHtmlWritable = await finalHtml.createWritable();
      const tmpHtmlFile = await tempHtmlHandle.getFile();
      const tmpReader = tmpHtmlFile.stream().getReader();
      while (true) {
        const { done, value } = await tmpReader.read();
        if (done) break;
        await finalHtmlWritable.write(value);
      }
      await finalHtmlWritable.close();

      try {
        await userFolderHandle.removeEntry(tempHtmlName);
      } catch (e) {}
      console.log(`🗑️ HTML companion cleaned: ${removedIds.size} entries removed`);
    } catch (e) {
      console.log('ℹ️ No HTML companion file to clean');
    }
  }

  // Metadata
  const metadata = await readSyncMetadata(userFolderHandle, provider);
  if (metadata) {
    metadata.totalEmails = kept;
    await writeSyncMetadata(userFolderHandle, provider, metadata);
  }

  console.log(
    `🗑️ Batch JSONL clean-up: ${removed} emails removed (${subjectsToRemove.length} subjects), ${kept} kept`
  );
  return { removed, kept };
}

/**
 * Loads the bodyHtml of an email from the HTML companion file.
 * Streaming read — stops as soon as the ID is found.
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @param {string} emailId - ID of the email to load
 * @returns {Promise<string|null>} bodyHtml or null if not found
 */
export async function loadBodyHtmlForEmail(provider, userId, emailId) {
  // Demo mode: the HTML companion is an embedded asset, read through the same fake
  // handle as the main JSONL — the scan logic below is shared.
  if (isDemoMode()) {
    const demoHandle = await getDemoHtmlFileHandle(provider);
    if (!demoHandle) return null;
    return await scanHtmlCompanionForEmail(demoHandle, emailId);
  }

  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return null;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) throw new Error('Data folder not found');
    const htmlFileName = getHtmlFileName(provider);

    const fileHandle = await userFolderHandle.getFileHandle(htmlFileName);
    return await scanHtmlCompanionForEmail(fileHandle, emailId);
  } catch (e) {
    console.warn('⚠️ Unable to load bodyHtml:', e.message);
    return null;
  }
}

/**
 * Scans an HTML companion file line by line and returns the bodyHtml for the ID.
 * Streaming read — stops as soon as the ID is found.
 * @param {FileSystemFileHandle} fileHandle - Handle (real or duck-typed) of the companion
 * @param {string} emailId
 * @returns {Promise<string|null>}
 */
async function scanHtmlCompanionForEmail(fileHandle, emailId) {
  try {
    const file = await fileHandle.getFile();
    const stream = file.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of stream) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        if (!line.includes(emailId)) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.id === emailId) {
            return entry.bodyHtml || null;
          }
        } catch (e) {}
      }
    }

    if (buffer.trim() && buffer.includes(emailId)) {
      try {
        const entry = JSON.parse(buffer);
        if (entry.id === emailId) {
          return entry.bodyHtml || null;
        }
      } catch (e) {}
    }

    return null;
  } catch (e) {
    console.warn('⚠️ Unable to load bodyHtml:', e.message);
    return null;
  }
}

/**
 * Re-downloads emails missing from the JSONL (without a date filter).
 * Used after restoring an excluded subject: fetches all IDs from the API,
 * deduplicates against the existing JSONL, downloads the missing ones in append mode.
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @returns {Promise<boolean>} true if emails were downloaded
 */
export async function redownloadMissingEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return false;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) throw new Error('Data folder not found');

    const filters = getCurrentFilters();

    // Fetch ALL message IDs from API (no afterDate — we want old emails too)
    const params = new URLSearchParams();
    if (filters) params.set('filters', JSON.stringify(filters));
    // Explicitly NO afterDate parameter

    console.log(`🔄 Re-download: retrieving all IDs from ${provider}...`);
    const response = await fetch(`/${provider}/emails?${params.toString()}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.requiresLogout) {
        console.warn('⚠️ Expired token — re-download cancelled');
        return false;
      }
      throw new Error(`Error retrieving IDs: ${response.status}`);
    }

    const emailData = await response.json();
    let messageIds = emailData.messageIds || [];
    if (messageIds.length === 0) return false;

    // Deduplicate against existing JSONL
    const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
    let existingIds = new Set();

    try {
      const fileHandle = await userFolderHandle.getFileHandle(fileName);
      const fileInfo = await analyzeEmailFile(fileHandle);
      existingIds = fileInfo.emailIds || new Set();
    } catch (e) {
      // No JSONL yet — all IDs are new
    }

    const countBefore = messageIds.length;
    messageIds = messageIds.filter((m) => !existingIds.has(m.id));
    console.log(`🔍 Deduplication: ${countBefore} IDs → ${messageIds.length} missing`);

    if (messageIds.length === 0) {
      console.log('✅ No missing emails to re-download');
      return false;
    }

    // Download missing emails in append mode, silently
    const metadata = await readSyncMetadata(userFolderHandle, provider);
    await downloadEmails(messageIds, provider, userId, {
      appendMode: true,
      silent: true,
      existingEmailCount: metadata?.totalEmails || existingIds.size,
    });

    console.log(`✅ ${messageIds.length} emails re-downloaded`);
    return true;
  } catch (e) {
    console.error('❌ Error re-downloading:', e);
    return false;
  }
}

/**
 * Migrates an old-format JSONL (with bodyHtml) to the new split format.
 * Automatically detects whether migration is needed by reading the first line.
 * @param {string} provider - "gmail" or "outlook"
 * @param {string} userId - User email
 * @returns {Promise<boolean>} true if migration was performed
 */
export async function migrateJsonlIfNeeded(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return false;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, {
      create: false,
    });
    if (!userFolderHandle) throw new Error('Data folder not found');

    const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
    const htmlFileName = getHtmlFileName(provider);

    // Check if HTML companion already exists — if so, already migrated
    try {
      const htmlHandle = await userFolderHandle.getFileHandle(htmlFileName);
      const htmlFile = await htmlHandle.getFile();
      if (htmlFile.size > 0) {
        return false;
      }
    } catch (e) {
      // HTML file doesn't exist — check if main has bodyHtml
    }

    const mainHandle = await userFolderHandle.getFileHandle(fileName);
    const mainFile = await mainHandle.getFile();
    if (mainFile.size === 0) return false;

    // Read first line to check if bodyHtml is present
    const checkReader = mainFile.stream().getReader();
    const checkDecoder = new TextDecoder();
    let firstChunk = '';
    const { value } = await checkReader.read();
    if (value) firstChunk = checkDecoder.decode(value);
    checkReader.cancel();

    const firstLine = firstChunk.split('\n')[0];
    if (!firstLine) return false;

    try {
      const sample = JSON.parse(firstLine);
      if (!sample.bodyHtml && !sample.sizeEstimate && !sample.historyId) {
        return false;
      }
    } catch (e) {
      return false;
    }

    // Migration needed
    console.log('🔄 JSONL migration detected — extracting bodyHtml to a separate file...');

    const tempMainName = `${fileName}.migrate.temp`;
    const tempMainHandle = await userFolderHandle.getFileHandle(tempMainName, { create: true });
    const mainWritable = await tempMainHandle.createWritable();

    const htmlHandle = await userFolderHandle.getFileHandle(htmlFileName, { create: true });
    const htmlWritable = await htmlHandle.createWritable();

    const stream = mainFile.stream();
    const textDecoder = new TextDecoder();
    let buffer = '';
    let migrated = 0;

    for await (const chunk of stream) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const email = JSON.parse(line);
          if (email.bodyHtml) {
            await htmlWritable.write(
              JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n'
            );
          }
          const {
            bodyHtml: _bodyHtml,
            sizeEstimate: _sizeEstimate,
            historyId: _historyId,
            labelIds: _labelIds,
            ...clean
          } = email;
          await mainWritable.write(JSON.stringify(clean) + '\n');
          migrated++;
        } catch (e) {
          await mainWritable.write(line + '\n');
        }
      }
    }

    if (buffer.trim()) {
      try {
        const email = JSON.parse(buffer);
        if (email.bodyHtml) {
          await htmlWritable.write(
            JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n'
          );
        }
        const {
          bodyHtml: _bodyHtml,
          sizeEstimate: _sizeEstimate,
          historyId: _historyId,
          labelIds: _labelIds,
          ...clean
        } = email;
        await mainWritable.write(JSON.stringify(clean) + '\n');
        migrated++;
      } catch (e) {
        await mainWritable.write(buffer + '\n');
      }
    }

    await mainWritable.close();
    await htmlWritable.close();

    // Atomic swap for main file
    await userFolderHandle.removeEntry(fileName);
    const finalHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
    const finalWritable = await finalHandle.createWritable();
    const tempFile = await tempMainHandle.getFile();
    const tmpReader = tempFile.stream().getReader();

    while (true) {
      const { done, value } = await tmpReader.read();
      if (done) break;
      await finalWritable.write(value);
    }

    await finalWritable.close();
    try {
      await userFolderHandle.removeEntry(tempMainName);
    } catch (e) {}

    console.log(
      `✅ Migration complete: ${migrated} emails migrated, bodyHtml extracted to ${htmlFileName}`
    );
    return true;
  } catch (e) {
    console.warn('⚠️ JSONL migration failed:', e.message);
    return false;
  }
}
