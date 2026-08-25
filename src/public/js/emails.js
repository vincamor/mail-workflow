/**
 * Module de gestion du téléchargement des emails
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
  restoreStandardLoadingOverlay
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
  const filteredText = filtered > 0 ? ` (${filtered} filtrés)` : '';
  text.textContent = `Téléchargement : ${received}/${total} emails${filteredText} (${pct}%)`;
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

// ─── Comparaison de filtres (insensible à l'ordre des arrays) ────────────────

/**
 * Normalise un objet filtres pour comparaison stable :
 * - Trie les arrays (blacklistedSenders, blacklistedKeywords)
 * - Retire les champs qui ont leur valeur par défaut et qui n'existaient pas avant
 *   (backward compat : évite un re-download quand on ajoute un nouveau champ)
 */
function normalizeFiltersForComparison(filters) {
  if (!filters) return null;
  const copy = { ...filters };
  // Trier les arrays pour que l'ordre n'impacte pas la comparaison
  if (copy.blacklistedSenders) copy.blacklistedSenders = [...copy.blacklistedSenders].sort();
  if (copy.blacklistedKeywords) copy.blacklistedKeywords = [...copy.blacklistedKeywords].sort();
  if (copy.notificationKeywords) copy.notificationKeywords = [...copy.notificationKeywords].sort();
  if (copy.promotionalKeywords) copy.promotionalKeywords = [...copy.promotionalKeywords].sort();
  // Retirer les champs qui n'impactent pas le contenu téléchargé
  // (autoExcludeRepetitive n'affecte que le filtrage en cours, pas le résultat d'un re-download)
  delete copy.autoExcludeRepetitive;
  delete copy.blacklistedSubjects;
  // customAfterDate : un changement de date doit bien déclencher un re-download
  // useCustomAfterDate : idem
  return copy;
}

// ─── Metadata de sync ────────────────────────────────────────────────────────

/**
 * Lit le fichier de metadata de sync depuis le dossier utilisateur.
 * Retourne null si le fichier n'existe pas (= premier téléchargement).
 * @param {FileSystemDirectoryHandle} userFolderHandle - Dossier EmailWorkflow/{userId}/
 * @param {string} provider - "gmail" ou "outlook"
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
 * Écrit (ou écrase) le fichier de metadata de sync.
 * @param {FileSystemDirectoryHandle} userFolderHandle - Dossier EmailWorkflow/{userId}/
 * @param {string} provider - "gmail" ou "outlook"
 * @param {Object} metadata - Données à stocker
 */
export async function writeSyncMetadata(userFolderHandle, provider, metadata) {
  const metaFileName = `${provider}_sync_metadata.json`;
  try {
    const fileHandle = await userFolderHandle.getFileHandle(metaFileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(metadata, null, 2));
    await writable.close();
    console.log(`✅ Metadata sync écrite dans ${metaFileName}`);
  } catch (e) {
    console.error(`❌ Erreur écriture metadata sync:`, e);
  }
}

// ─── Téléchargement des emails ────────────────────────────────────────────────

/**
 * Télécharge une liste d'emails et les écrit dans le fichier JSONL.
 * @param {Array} availableMessageIds - IDs des messages à télécharger
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @param {Object} options
 * @param {boolean} options.appendMode - true = ajout aux emails existants, false = réécriture complète
 * @param {boolean} options.silent - true = pas de dialog de confirmation (sync automatique)
 * @param {number} options.existingEmailCount - Nombre d'emails déjà présents (pour le total dans la metadata)
 */
export async function downloadEmails(availableMessageIds, provider, userId, options = {}) {
  const {
    appendMode = false,
    silent = false,
    existingEmailCount = 0,
    onMilestone = null,
    milestoneInterval = 1000
  } = options;

  if (!availableMessageIds.length) {
    if (!silent) toastInfo("Aucun nouvel email \u00e0 t\u00e9l\u00e9charger.");
    return;
  }
  
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) {
    if (!silent) toastWarning("Veuillez d\u2019abord choisir un dossier de sauvegarde.");
    return;
  }

  if (!silent) {
    const confirmed = await showConfirmModal({
      title: appendMode ? 'Ajouter des emails' : 'T\u00e9l\u00e9charger les emails',
      message: appendMode
        ? `Ajouter <strong>${availableMessageIds.length}</strong> nouveaux emails \u00e0 votre collection\u00a0?<br><br>Les emails existants seront conserv\u00e9s.`
        : `T\u00e9l\u00e9charger <strong>${availableMessageIds.length}</strong> emails en tranches de 500\u00a0?<br><br>Cette op\u00e9ration peut prendre plusieurs minutes.`,
      html: true,
      type: 'info',
      confirmText: appendMode ? 'Ajouter' : 'T\u00e9l\u00e9charger',
    });
    if (!confirmed) return;
  }

  // Declares hors du try pour rester accessibles dans le catch (fermeture des
  // writables sur chemin d'erreur — sinon `writable` fuyait sur certains chemins
  // alors que `htmlWritable` etait ferme).
  let writable = null;
  let htmlWritable = null;

  try {
    // Récupérer les filtres actuels
    const filters = getCurrentFilters();
    
    // Afficher l'animation de téléchargement avec emails volants
    showEmailDownloadAnimation(availableMessageIds.length);
    showInlineProgress();

    // Afficher le statut de téléchargement
    const statusDiv = document.getElementById("status");
    statusDiv.textContent = `📦 Téléchargement de ${availableMessageIds.length} emails en cours...`;

    // Initialiser le compteur à 0
    updateEmailDownloadCounter(0, availableMessageIds.length);

    // Utiliser fetch pour envoyer les données (POST) et recevoir le stream SSE
    // URL dynamique selon le provider — ne pas hardcoder /gmail/download-chunks
    console.log(`📡 Download chunks — provider: ${provider}, URL: /${provider}/download-chunks`);
    const response = await fetch(`/${provider}/download-chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messageIds: availableMessageIds,
        chunkSize: 500,
        filters: filters
      }),
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    // Résolution tolérante du dossier de données (crée la structure par défaut si absente).
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: true });
    
    // Déterminer le nom du fichier selon le provider
    let fileName = "emails.jsonl";
    if (provider === "gmail") fileName = "gmail_emails.jsonl";
    else if (provider === "outlook") fileName = "outlook_emails.jsonl";

    // Préparer l'écriture selon le mode (writable est declare plus haut)
    let tempFileHandle = null;
    const tempFileName = `${fileName}.temp`;

    if (appendMode) {
      // Mode append : ouvrir le fichier existant et se positionner à la fin
      const finalFileHandle = await userFolderHandle.getFileHandle(fileName, { create: true });
      const existingFile = await finalFileHandle.getFile();
      writable = await finalFileHandle.createWritable({ keepExistingData: true });
      await writable.seek(existingFile.size);
      console.log(`📎 Mode append: positionnement à la fin du fichier (${existingFile.size} octets existants)`);
    } else {
      // Mode overwrite : écrire dans un fichier temporaire puis remplacer
      tempFileHandle = await userFolderHandle.getFileHandle(tempFileName, { create: true });
      writable = await tempFileHandle.createWritable();
    }

    // HTML companion file — same mode (append or overwrite) as main file
    // (htmlWritable est declare plus haut pour etre accessible dans le catch)
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

    // Lire le stream SSE et écrire directement chunk par chunk
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let downloadResult = null;
    let emailsWritten = 0;
    let maxInternalDate = null; // Pour la metadata de sync
    const accumulatedEmails = [];
    let lastMilestoneCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Traiter les événements SSE
        const lines = buffer.split('\n');
        buffer = lines.pop();
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            
            if (data.type === 'start') {
              console.log(`🚀 Démarrage: ${data.totalEmails} emails en ${data.totalChunks} chunks`);
            } 
            else if (data.type === 'emails') {
              // Écrire directement chunk par chunk sans accumuler en mémoire
              for (const email of data.emails) {
                // Write bodyHtml to companion file
                if (email.bodyHtml) {
                  await htmlWritable.write(JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n');
                }
                // Write main email without bodyHtml and unused fields
                const { bodyHtml: _bodyHtml, sizeEstimate: _sizeEstimate, historyId: _historyId, labelIds: _labelIds, ...emailWithoutHtml } = email;
                await writable.write(JSON.stringify(emailWithoutHtml) + '\n');
                emailsWritten++;
                // Suivre la date max pour la metadata de sync
                if (email.internalDate) {
                  const ts = parseInt(email.internalDate);
                  if (!maxInternalDate || ts > maxInternalDate) maxInternalDate = ts;
                }
              }
              console.log(`💾 ${data.emails.length} emails écrits sur disque (total: ${emailsWritten} écrits)`);

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
                      totalRequested: availableMessageIds.length
                    });
                  } catch (e) {
                    console.warn('⚠️ Erreur dans onMilestone:', e);
                  }
                }
              }

              // Mise à jour visuelle immédiate pendant l'écriture
              const progress = (emailsWritten / availableMessageIds.length) * 100;
              updateLoadingOverlay(`Écriture sur disque... ${emailsWritten} emails sauvegardés`, progress);
            }
            else if (data.type === 'progress') {
              // Mise à jour en temps réel à chaque chunk
              const chunkInfo = `Chunk ${data.chunkIndex}/${data.totalChunks}`;
              
              // Mise à jour de l'overlay avec compteur animé
              updateEmailDownloadCounter(data.totalRetrieved, data.totalRequested, chunkInfo);
              
              // Mise à jour du status avec info filtres
              const filteredInfo = data.totalFiltered > 0 ? ` (${data.totalFiltered} filtrés)` : '';
              statusDiv.textContent = `📦 ${data.totalRetrieved} / ${data.totalRequested} emails${filteredInfo} - ${chunkInfo}`;
              
              // Log pour debug
              console.log(`📊 Progression: ${data.totalRetrieved}/${data.totalRequested} (${data.percentage}%) - ${chunkInfo}${filteredInfo}`);
              updateInlineProgress(data.totalRetrieved, data.totalRequested, data.totalFiltered);
            } 
            else if (data.type === 'complete') {
              downloadResult = data;
              // Final milestone
              if (onMilestone && accumulatedEmails.length > 0) {
                try {
                  onMilestone([...accumulatedEmails], {
                    isFinal: true,
                    totalReceived: accumulatedEmails.length,
                    totalRequested: availableMessageIds.length
                  });
                } catch (e) {
                  console.warn('⚠️ Erreur dans onMilestone (final):', e);
                }
              }
              console.log(`\n📊 ═══ BILAN TÉLÉCHARGEMENT ═══`);
              console.log(`   Emails demandés: ${data.totalRequested}`);
              console.log(`   Emails gardés: ${data.totalRetrieved}`);
              console.log(`   Emails filtrés (règles): ${data.totalFiltered - (data.totalAutoExcluded || 0)}`);
              console.log(`   Emails auto-exclus: ${data.totalAutoExcluded || 0}`);
              if (data.autoExcludedSenders && data.autoExcludedSenders.length > 0) {
                console.log(`   Senders auto-exclus:`);
                data.autoExcludedSenders.forEach(s => console.log(`     → ${s}`));
              }
              if (data.topSenders && data.topSenders.length > 0) {
                console.log(`   Top senders (diagnostic):`);
                data.topSenders.forEach(s => {
                  console.log(`     ${s.status.padEnd(12)} | ${String(s.count).padStart(3)} mails | ${s.sender}`);
                  if (s.normalized) {
                    console.log(`       sujets originaux: ${JSON.stringify(s.subjects)}`);
                    console.log(`       sujets normalises: ${JSON.stringify(s.normalized)}`);
                    console.log(`       match: ${s.maxMatch}/5 | body moy: ${s.avgBody} | body lengths: [${s.bodyLengths}]`);
                  }
                });
              }
              console.log(`═══════════════════════════════\n`);
              // Persister les senders auto-exclus dans la blacklist
              if (data.autoExcludedSenders && data.autoExcludedSenders.length > 0) {
                try {
                  const liveFilters = getCurrentFilters();
                  if (liveFilters) {
                    if (!liveFilters.blacklistedSenders) liveFilters.blacklistedSenders = [];
                    const existing = new Set(liveFilters.blacklistedSenders.map(s => s.toLowerCase()));
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
                      updateCurrentFilters(liveFilters); // sync en mémoire
                      console.log(`✅ ${added} sender(s) ajoutés à la blacklist pour les prochains téléchargements`);
                    }
                  }
                } catch (e) {
                  console.warn('⚠️ Impossible de persister les senders auto-exclus:', e);
                }
              }
            } 
            else if (data.type === 'error') {
              throw new Error(data.error);
            }
          }
        }
      }
    } finally {
      await writable.close();
      if (htmlWritable) await htmlWritable.close();
      console.log(`💾 Fichier fermé: ${emailsWritten} emails écrits`);
    }

    if (!downloadResult || !downloadResult.success) {
      throw new Error(downloadResult?.message || "Erreur de téléchargement");
    }

    const filteredText = downloadResult.totalFiltered > 0
      ? ` (${downloadResult.totalFiltered} filtrés)`
      : '';
    const autoText = downloadResult.totalAutoExcluded > 0
      ? ` (${downloadResult.totalAutoExcluded} auto-exclus)`
      : '';
    statusDiv.textContent = `✅ ${downloadResult.totalRetrieved} emails téléchargés${filteredText}${autoText}`;

    if (!appendMode) {
      // Mode overwrite : copier le temp vers le fichier final puis supprimer le temp
      console.log(`📧 ${emailsWritten} emails écrits dans ${tempFileName}`);

      try {
        await userFolderHandle.removeEntry(fileName);
        console.log(`🗑️ Ancien fichier ${fileName} supprimé`);
      } catch (e) {
        console.log(`Aucun ancien fichier à supprimer`);
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
      console.log(`✅ ${emailsWritten} emails copiés dans ${fileName}`);

      try {
        await userFolderHandle.removeEntry(tempFileName);
        console.log(`🗑️ Fichier temporaire ${tempFileName} supprimé`);
      } catch (e) {
        console.log(`Impossible de supprimer ${tempFileName}`);
      }
    } else {
      console.log(`✅ ${emailsWritten} emails ajoutés dans ${fileName} (mode append)`);
    }

    // Also swap HTML companion file in overwrite mode
    if (!appendMode && tempHtmlFileHandle) {
      try {
        await userFolderHandle.removeEntry(htmlFileName);
      } catch (e) {
        console.log('Aucun ancien fichier HTML à supprimer');
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
        console.log('Impossible de supprimer le fichier HTML temporaire');
      }
    }

    // Écrire la metadata de sync
    const filtersToSave = getCurrentFilters();
    const metadataToWrite = {
      lastSyncDate: new Date().toISOString(),
      lastInternalDate: maxInternalDate ? String(maxInternalDate) : null,
      totalEmails: existingEmailCount + emailsWritten,
      filtersUsed: filtersToSave,
      provider: provider
    };
    await writeSyncMetadata(userFolderHandle, provider, metadataToWrite);
    console.log(`💾 Metadata sync écrite:`);
    console.log(`   ├─ lastSyncDate: ${metadataToWrite.lastSyncDate}`);
    console.log(`   ├─ totalEmails: ${metadataToWrite.totalEmails}`);
    console.log(`   ├─ blacklistedSenders dans metadata: ${(filtersToSave?.blacklistedSenders || []).length} entrées`);
    console.log(`   └─ autoExcludeRepetitive: ${filtersToSave?.autoExcludeRepetitive}`);

    // Afficher l'animation de succès
    showDownloadSuccessAnimation(emailsWritten);
    
    const actionText = appendMode ? 'ajoutés' : 'sauvegardés';
    const finalMessage =
      `${emailsWritten} emails ${actionText} dans\n` +
      `${currentFolderHandle.name}/EmailWorkflow/${userId}/${fileName}`;
    
    setTimeout(() => {
      hideLoadingOverlay();
      hideInlineProgress();
      restoreStandardLoadingOverlay();
      if (!silent) toastSuccess(finalMessage, 6000);
    }, 2000);

  } catch (e) {
    // Fermer les deux writables si encore ouverts (close() sur un writable deja
    // ferme rejette → chaque close est isole dans son propre try/catch).
    try { if (writable) await writable.close(); } catch (_) {}
    try { if (htmlWritable) await htmlWritable.close(); } catch (_) {}
    hideInlineProgress();
    restoreStandardLoadingOverlay();
    hideLoadingOverlay();
    if (!silent) toastError("Erreur lors de la sauvegarde : " + e.message);
    else console.error("Erreur téléchargement (mode silencieux):", e.message);
  }
}

// ─── Sync incrémentale ────────────────────────────────────────────────────────

/**
 * Crée le fichier gmail_sync_metadata.json depuis un JSONL déjà existant,
 * sans avoir besoin de re-télécharger les emails.
 * Appelé automatiquement par syncEmails() si le JSONL existe mais pas la metadata.
 *
 * @param {FileSystemDirectoryHandle} userFolderHandle - Dossier EmailWorkflow/{userId}/
 * @param {string} provider - "gmail" ou "outlook"
 * @param {Object} currentFilters - Filtres actuellement actifs
 * @returns {boolean} true si le bootstrap a réussi, false si le JSONL n'existe pas
 */
async function bootstrapSyncMetadata(userFolderHandle, provider, currentFilters) {
  const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';

  try {
    const fileHandle = await userFolderHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();

    if (file.size === 0) return false;

    console.log(`🔧 Bootstrap metadata depuis ${fileName} (${Math.round(file.size / 1024)} Ko)...`);

    // Lire le fichier en streaming pour trouver le max internalDate sans tout charger
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
          // Ligne malformée, ignorée
        }
      }
    }

    // Traiter la dernière ligne
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

    // Écrire la metadata
    await writeSyncMetadata(userFolderHandle, provider, {
      lastSyncDate: new Date().toISOString(),
      lastInternalDate: maxInternalDate ? String(maxInternalDate) : null,
      totalEmails: totalEmails,
      filtersUsed: currentFilters,
      provider: provider,
      bootstrapped: true // Marqueur pour savoir que la metadata a été créée depuis un JSONL existant
    });

    console.log(`✅ Bootstrap terminé: ${totalEmails} emails indexés, dernier email: ${maxInternalDate ? new Date(maxInternalDate).toISOString() : 'inconnu'}`);
    return true;

  } catch (e) {
    // Le fichier JSONL n'existe pas
    return false;
  }
}

/**
 * Orchestre la synchronisation incrémentale des emails.
 * - Si aucune metadata : premier téléchargement (comportement existant).
 * - Si filtres changés  : re-téléchargement complet (mode strict).
 * - Sinon              : téléchargement uniquement des emails plus récents + déduplication.
 *
 * Appelée automatiquement au chargement de la page ET par le bouton "Mettre à jour".
 *
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId   - Email de l'utilisateur
 * @returns {boolean} true si une sync a été effectuée, false si rien à faire
 */
export async function syncEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) {
    console.log('📁 Aucun dossier sélectionné, sync annulée');
    return false;
  }

  try {
    // Résolution tolérante du dossier de données.
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
    if (!userFolderHandle) {
      // Le dossier n'existe pas encore : premier téléchargement manuel requis
      console.log('📁 Dossier de données inexistant — premier téléchargement requis');
      return false;
    }

    // Lire la metadata de la dernière sync
    let metadata = await readSyncMetadata(userFolderHandle, provider);
    const currentFilters = getCurrentFilters();

    // Aucune metadata mais un fichier JSONL existe déjà → bootstrap automatique
    if (!metadata) {
      const bootstrapped = await bootstrapSyncMetadata(userFolderHandle, provider, currentFilters);
      if (bootstrapped) {
        metadata = await readSyncMetadata(userFolderHandle, provider);
        console.log('🔧 Metadata créée depuis le JSONL existant — sync incrémentale activée');
      } else {
        // Ni metadata ni fichier JSONL : premier téléchargement requis manuellement
        console.log('📋 Aucun fichier email trouvé — premier téléchargement requis');
        return false;
      }
    }

    const normalizedSaved = normalizeFiltersForComparison(metadata.filtersUsed);
    const normalizedCurrent = normalizeFiltersForComparison(currentFilters);
    const filtersChanged = JSON.stringify(normalizedSaved) !== JSON.stringify(normalizedCurrent);

    console.log(`🔍 Comparaison filtres pour sync:`);
    console.log(`   ├─ blacklistedSenders (metadata): ${(metadata.filtersUsed?.blacklistedSenders || []).length} entrées`);
    console.log(`   ├─ blacklistedSenders (actuels): ${(currentFilters?.blacklistedSenders || []).length} entrées`);
    console.log(`   └─ filtersChanged: ${filtersChanged}`);

    let afterDate = null;
    let appendMode = false;

    if (filtersChanged) {
      console.log('🔄 Filtres modifiés depuis la dernière sync → re-téléchargement complet');
      afterDate = null;
      appendMode = false;
    } else {
      afterDate = metadata.lastInternalDate;
      appendMode = true;
      if (afterDate) {
        console.log(`📅 Sync incrémentale depuis: ${new Date(parseInt(afterDate)).toISOString()}`);
      }
    }

    // Si une date personnalisée est définie et qu'on n'a pas de date plus récente,
    // l'utiliser comme borne inférieure
    if (currentFilters && currentFilters.useCustomAfterDate && currentFilters.customAfterDate) {
      const customMs = String(new Date(currentFilters.customAfterDate).getTime());
      if (!afterDate || parseInt(customMs) > parseInt(afterDate)) {
        afterDate = customMs;
        console.log(`📅 Date personnalisée appliquée: ${currentFilters.customAfterDate}`);
      }
    }

    // Récupérer les IDs depuis le bon provider (avec filtre de date si incrémental)
    // URL dynamique — ne pas hardcoder /gmail/emails
    const params = new URLSearchParams();
    if (currentFilters) params.set('filters', JSON.stringify(currentFilters));
    if (afterDate) params.set('afterDate', afterDate);

    console.log(`📡 syncEmails — provider: ${provider}, URL: /${provider}/emails`);
    const response = await fetch(`/${provider}/emails?${params.toString()}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.requiresLogout) {
        console.warn('⚠️ Token expiré — sync annulée');
        return false;
      }
      throw new Error(`Erreur récupération IDs: ${response.status}`);
    }

    const emailData = await response.json();
    let messageIds = emailData.messageIds || [];

    if (messageIds.length === 0) {
      console.log('✅ Aucun nouvel email — collection à jour');
      return false;
    }

    // Déduplication : retirer les IDs déjà présents dans le JSONL
    if (appendMode) {
      const fileName = provider === 'gmail' ? 'gmail_emails.jsonl' : 'outlook_emails.jsonl';
      let existingIds = new Set();

      try {
        const fileHandle = await userFolderHandle.getFileHandle(fileName);
        const fileInfo = await analyzeEmailFile(fileHandle);
        existingIds = fileInfo.emailIds || new Set();
        console.log(`📊 ${existingIds.size} emails existants dans le fichier`);
      } catch (e) {
        // Fichier JSONL absent : tous les IDs sont nouveaux
      }

      const countBefore = messageIds.length;
      messageIds = messageIds.filter(m => !existingIds.has(m.id));
      console.log(`🔍 Déduplication: ${countBefore} IDs récupérés → ${messageIds.length} véritablement nouveaux`);

      if (messageIds.length === 0) {
        console.log('✅ Tous les emails récents sont déjà synchronisés');
        return false;
      }
    }

    // Lancer le téléchargement (silencieux, en mode append ou overwrite)
    await downloadEmails(messageIds, provider, userId, {
      appendMode: appendMode,
      silent: true,
      existingEmailCount: appendMode ? (metadata?.totalEmails || 0) : 0
    });

    return true;

  } catch (error) {
    console.error('❌ Erreur sync emails:', error);
    return false;
  }
}

// ─── Polling léger (badge "nouveaux emails") ──────────────────────────────────

let _pollingInterval = null;

/**
 * Vérifie silencieusement le nombre de nouveaux emails disponibles
 * et met à jour le badge du bouton "Mettre à jour".
 * N'effectue aucun téléchargement.
 *
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId   - Email de l'utilisateur
 */
export async function checkForNewEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return;

  try {
    // Accéder au dossier utilisateur
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
    if (!userFolderHandle) throw new Error('Dossier de données introuvable');

    const metadata = await readSyncMetadata(userFolderHandle, provider);
    if (!metadata || !metadata.lastInternalDate) return;

    // Appel léger : juste un comptage, pas de contenu
    const params = new URLSearchParams({ afterDate: metadata.lastInternalDate });
    if (metadata.filtersUsed) params.set('filters', JSON.stringify(metadata.filtersUsed));

    const response = await fetch(`/${provider}/count?${params.toString()}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.requiresLogout) console.warn('⚠️ Token expiré — polling annulé');
      return;
    }

    const { newCount } = await response.json();
    updateNewEmailsBadge(newCount);

    if (newCount > 0) {
      console.log(`📬 ${newCount} nouveaux emails disponibles`);
    }

  } catch (e) {
    // Silencieux : dossier inexistant, pas de metadata, etc.
  }
}

/**
 * Met à jour le badge du bouton "Mettre à jour".
 * @param {number} count - Nombre de nouveaux emails (0 = aucun)
 */
export function updateNewEmailsBadge(count) {
  const btn = document.getElementById('updateEmailsBtn');
  const badge = document.getElementById('newEmailCountBadge');
  if (!btn || !badge) return;

  badge.textContent = count > 0 ? count : '0';

  if (count > 0) {
    btn.classList.add('has-updates');
    btn.title = `${count} nouveaux emails disponibles`;
  } else {
    btn.classList.remove('has-updates');
    btn.title = '';
  }
}

/**
 * Démarre le polling toutes les `intervalMs` ms (défaut : 5 min).
 * Lance un premier check immédiatement.
 *
 * @param {string} provider
 * @param {string} userId
 * @param {number} intervalMs - Intervalle en millisecondes (défaut : 300 000 = 5 min)
 */
export function startEmailPolling(provider, userId, intervalMs = 5 * 60 * 1000) {
  stopEmailPolling();

  // Premier check immédiat au démarrage
  checkForNewEmails(provider, userId);

  _pollingInterval = setInterval(() => checkForNewEmails(provider, userId), intervalMs);
  console.log(`🔄 Polling démarré (toutes les ${intervalMs / 1000}s)`);
}

/**
 * Arrête le polling en cours.
 */
export function stopEmailPolling() {
  if (_pollingInterval) {
    clearInterval(_pollingInterval);
    _pollingInterval = null;
  }
}

/**
 * Supprime du fichier JSONL tous les emails dont le sujet (nettoyé) correspond.
 * Réécriture atomique : lecture → filtre → écriture dans un temp → swap.
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @param {string} subjectToRemove - Sujet à supprimer (déjà nettoyé, sans Re:/Fwd:)
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupExcludedSubjectFromJSONL(provider, userId, subjectToRemove) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) throw new Error('Aucun dossier sélectionné');

  const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
  if (!userFolderHandle) throw new Error('Dossier de données introuvable');

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
      const cleanSubject = (email.subject || '')
        .replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '')
        .trim();
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
    console.warn('⚠️ Impossible de supprimer l\'ancien fichier:', e);
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
    console.log('Impossible de supprimer le fichier temporaire');
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

      try { await userFolderHandle.removeEntry(tempHtmlName); } catch (e) {}
      console.log(`🗑️ Fichier HTML nettoyé: ${removedIds.size} entrées supprimées`);
    } catch (e) {
      console.log('ℹ️ Pas de fichier HTML companion à nettoyer');
    }
  }

  // Update sync metadata
  const metadata = await readSyncMetadata(userFolderHandle, provider);
  if (metadata) {
    metadata.totalEmails = kept;
    await writeSyncMetadata(userFolderHandle, provider, metadata);
  }

  console.log(`🗑️ Nettoyage JSONL: ${removed} emails supprimés, ${kept} conservés pour le sujet "${subjectToRemove}"`);
  return { removed, kept };
}

/**
 * Version batch : supprime plusieurs sujets du JSONL (et de son HTML companion)
 * en UNE SEULE passe sur chaque fichier. Beaucoup plus rapide que d'appeler
 * cleanupExcludedSubjectFromJSONL en boucle pour N sujets (qui lirait le fichier
 * N fois).
 *
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @param {string[]} subjectsToRemove - Sujets a supprimer (deja nettoyes, sans Re:/Fwd:)
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupExcludedSubjectsFromJSONL(provider, userId, subjectsToRemove) {
  if (!subjectsToRemove || subjectsToRemove.length === 0) {
    return { removed: 0, kept: 0 };
  }

  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) throw new Error('Aucun dossier sélectionné');

  const excludeSet = new Set(subjectsToRemove);
  const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
  if (!userFolderHandle) throw new Error('Dossier de données introuvable');

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
      const cleanSubject = (email.subject || '')
        .replace(/^(Re:|Fwd:|FW:|RE:|FWD:)\s*/i, '')
        .trim();
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

  // Atomic swap JSONL principal
  try {
    await userFolderHandle.removeEntry(fileName);
  } catch (e) {
    console.warn('⚠️ Impossible de supprimer l\'ancien fichier:', e);
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

  try { await userFolderHandle.removeEntry(tempFileName); } catch (e) {}

  // HTML companion — UNE SEULE passe aussi
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

      try { await userFolderHandle.removeEntry(tempHtmlName); } catch (e) {}
      console.log(`🗑️ HTML companion nettoye: ${removedIds.size} entrees supprimees`);
    } catch (e) {
      console.log('ℹ️ Pas de fichier HTML companion a nettoyer');
    }
  }

  // Metadata
  const metadata = await readSyncMetadata(userFolderHandle, provider);
  if (metadata) {
    metadata.totalEmails = kept;
    await writeSyncMetadata(userFolderHandle, provider, metadata);
  }

  console.log(`🗑️ Nettoyage JSONL batch: ${removed} emails supprimes (${subjectsToRemove.length} sujets), ${kept} conserves`);
  return { removed, kept };
}

/**
 * Charge le bodyHtml d'un email depuis le fichier HTML companion.
 * Lecture en streaming — s'arrête dès que l'ID est trouvé.
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @param {string} emailId - ID de l'email à charger
 * @returns {Promise<string|null>} bodyHtml ou null si non trouvé
 */
export async function loadBodyHtmlForEmail(provider, userId, emailId) {
  // Mode demo : le companion HTML est un asset embarque, lu via le meme faux
  // handle que le JSONL principal — la logique de scan ci-dessous est partagee.
  if (isDemoMode()) {
    const demoHandle = await getDemoHtmlFileHandle(provider);
    if (!demoHandle) return null;
    return await scanHtmlCompanionForEmail(demoHandle, emailId);
  }

  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return null;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
    if (!userFolderHandle) throw new Error('Dossier de données introuvable');
    const htmlFileName = getHtmlFileName(provider);

    const fileHandle = await userFolderHandle.getFileHandle(htmlFileName);
    return await scanHtmlCompanionForEmail(fileHandle, emailId);
  } catch (e) {
    console.warn('⚠️ Impossible de charger bodyHtml:', e.message);
    return null;
  }
}

/**
 * Scanne un fichier companion HTML ligne par ligne et retourne le bodyHtml de l'ID.
 * Lecture en streaming — s'arrête dès que l'ID est trouvé.
 * @param {FileSystemFileHandle} fileHandle - Handle (reel ou duck-type) du companion
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
    console.warn('⚠️ Impossible de charger bodyHtml:', e.message);
    return null;
  }
}

/**
 * Re-télécharge les emails manquants du JSONL (sans filtre de date).
 * Utilisé après rétablissement d'un sujet exclu : fetch tous les IDs depuis l'API,
 * déduplique contre le JSONL existant, télécharge les manquants en mode append.
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @returns {Promise<boolean>} true si des emails ont été téléchargés
 */
export async function redownloadMissingEmails(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return false;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
    if (!userFolderHandle) throw new Error('Dossier de données introuvable');

    const filters = getCurrentFilters();

    // Fetch ALL message IDs from API (no afterDate — we want old emails too)
    const params = new URLSearchParams();
    if (filters) params.set('filters', JSON.stringify(filters));
    // Explicitly NO afterDate parameter

    console.log(`🔄 Re-téléchargement: récupération de tous les IDs depuis ${provider}...`);
    const response = await fetch(`/${provider}/emails?${params.toString()}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (err.requiresLogout) {
        console.warn('⚠️ Token expiré — re-téléchargement annulé');
        return false;
      }
      throw new Error(`Erreur récupération IDs: ${response.status}`);
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
    messageIds = messageIds.filter(m => !existingIds.has(m.id));
    console.log(`🔍 Déduplication: ${countBefore} IDs → ${messageIds.length} manquants`);

    if (messageIds.length === 0) {
      console.log('✅ Aucun email manquant à re-télécharger');
      return false;
    }

    // Download missing emails in append mode, silently
    const metadata = await readSyncMetadata(userFolderHandle, provider);
    await downloadEmails(messageIds, provider, userId, {
      appendMode: true,
      silent: true,
      existingEmailCount: metadata?.totalEmails || existingIds.size
    });

    console.log(`✅ ${messageIds.length} emails re-téléchargés`);
    return true;
  } catch (e) {
    console.error('❌ Erreur re-téléchargement:', e);
    return false;
  }
}

/**
 * Migre un JSONL ancien format (avec bodyHtml) vers le nouveau format split.
 * Détecte automatiquement si la migration est nécessaire en lisant la première ligne.
 * @param {string} provider - "gmail" ou "outlook"
 * @param {string} userId - Email de l'utilisateur
 * @returns {Promise<boolean>} true si migration effectuée
 */
export async function migrateJsonlIfNeeded(provider, userId) {
  const currentFolderHandle = getCurrentFolderHandle();
  if (!currentFolderHandle) return false;

  try {
    const userFolderHandle = await resolveUserFolderHandle(currentFolderHandle, userId, { create: false });
    if (!userFolderHandle) throw new Error('Dossier de données introuvable');

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
    console.log('🔄 Migration JSONL détectée — extraction de bodyHtml vers fichier séparé...');

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
            await htmlWritable.write(JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n');
          }
          const { bodyHtml: _bodyHtml, sizeEstimate: _sizeEstimate, historyId: _historyId, labelIds: _labelIds, ...clean } = email;
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
          await htmlWritable.write(JSON.stringify({ id: email.id, bodyHtml: email.bodyHtml }) + '\n');
        }
        const { bodyHtml: _bodyHtml, sizeEstimate: _sizeEstimate, historyId: _historyId, labelIds: _labelIds, ...clean } = email;
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
    try { await userFolderHandle.removeEntry(tempMainName); } catch (e) {}

    console.log(`✅ Migration terminée: ${migrated} emails migrés, bodyHtml extrait vers ${htmlFileName}`);
    return true;
  } catch (e) {
    console.warn('⚠️ Migration JSONL échouée:', e.message);
    return false;
  }
}

