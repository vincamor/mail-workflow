# Translation glossary

**Who this is for:** anyone translating French strings, comments or logs to
English in this codebase, and anyone writing new user-facing text.

The project is migrating to English everywhere: UI copy, code comments, log
messages and AI prompts. This file exists so that one French term always becomes
the same English term. Without it, `sujet` ends up as _subject_, _topic_ and
_thread_ in three different files, and the interface stops making sense.

> **Rule:** if a term is in this table, use the English column. If it is not,
> add it here rather than inventing a one-off translation.

---

## 1. The pivot term: `sujet` → **subject**

This is the most frequent domain word in the codebase (~164 occurrences) and the
one most likely to be translated inconsistently. It is **subject**, not _thread_
and not _conversation_.

The reason is factual, not stylistic. This app **does not group by RFC threading
headers**. `createTemporalGroupTree` groups by _normalised subject line_ — see
[`../guides/data-format.md`](../guides/data-format.md) §4, which states that
`references` and `threadId` do not drive the topology. Two unrelated emails that
happen to share a subject line land in the same group. Calling that a "thread"
would be inaccurate, and it would contradict the 44 `subject*` identifiers in the
code plus the `#subjectsList` DOM id that project rule 1 forbids renaming.

**Conversation** stays reserved for the _visualisation_: "conversation tree",
"conversation graph". That is the rendered object, not the grouping.

## 2. Core domain

| French                  | English            | Notes                                                         |
| ----------------------- | ------------------ | ------------------------------------------------------------- |
| sujet / sujets          | subject / subjects | See §1. Never _thread_                                        |
| arbre (de conversation) | conversation tree  | The SVG rendering                                             |
| fil / discussion        | subject            | Same concept as `sujet`; do not introduce a second word       |
| dossier                 | folder             | The local folder the user picks. Never _directory_ in UI copy |
| fichier                 | file               |                                                               |
| expéditeur              | sender             |                                                               |
| destinataire            | recipient          |                                                               |
| pièce jointe            | attachment         |                                                               |
| brouillon               | draft              |                                                               |
| réponse / répondre      | reply              | Noun and verb are both `reply`                                |
| participant             | participant        | Unchanged                                                     |
| citation                | quoted text        | The collapsed part of a reply, not "citation"                 |

## 3. Actions

| French                         | English            | Notes                                                        |
| ------------------------------ | ------------------ | ------------------------------------------------------------ |
| télécharger / téléchargement   | download           | Never _upload_, never _fetch_ in UI copy                     |
| analyser / analyse             | analyse / analysis | British spelling, consistent with the rest of the docs       |
| synchroniser / synchronisation | sync               | Short form in UI; "synchronisation" only in prose            |
| exclure / exclu                | exclude / excluded |                                                              |
| garder                         | keep               |                                                              |
| incertain                      | unsure             | The third state of the clean-up report. Not _uncertain_      |
| supprimer                      | delete             | Removing data. Use _remove_ only for taking out of a list    |
| enregistrer                    | save               |                                                              |
| réinitialiser                  | reset              |                                                              |
| afficher / masquer             | show / hide        |                                                              |
| sélectionner                   | select             |                                                              |
| se connecter / déconnexion     | sign in / sign out | Not _login_/_logout_ in UI copy; those stay in code and URLs |

## 4. Features

| French           | English                | Notes                                                      |
| ---------------- | ---------------------- | ---------------------------------------------------------- |
| Faire le ménage  | Clean-up               | The AI-assisted triage feature. Capitalised when naming it |
| nettoyage        | clean-up               | Lowercase when used descriptively                          |
| filtre / filtres | filter / filters       |                                                            |
| liste noire      | blocklist              | Not _blacklist_                                            |
| groupe / groupes | group / groups         | User-created groupings of subjects                         |
| favori / favoris | favourite / favourites | British spelling, consistent with "analyse"                |
| thème            | theme                  |                                                            |
| assistant IA     | AI assistant           |                                                            |

## 5. Technical

| French                | English     | Notes                                                     |
| --------------------- | ----------- | --------------------------------------------------------- |
| jeton                 | token       |                                                           |
| session               | session     | Unchanged                                                 |
| en-tête               | header      |                                                           |
| bac à sable           | sandbox     |                                                           |
| droits / permissions  | permissions |                                                           |
| par morceaux / chunks | chunks      | Keep `chunk`, it matches the code                         |
| flux                  | stream      |                                                           |
| poignée               | handle      | As in `FileSystemFileHandle`. Never translate it in prose |

## 6. Rules that are not vocabulary

1. **Never rename an identifier.** Variables, functions, DOM ids, CSS classes,
   file names and JSON keys stay exactly as they are. Project rule 1 forbids
   removing HTML ids, and renaming `subjectKey` or `#subjectsList` would break
   things silently. Translate the _text_, not the _code_.

2. **Never change a JSONL field name.** The on-disk format is a contract with
   data users already have. `bodyText`, `hasAttachments`, `internalDate` and the
   rest are frozen.

3. **Emoji in log messages stay.** `✅`, `⚠️`, `❌` and `🔍` are used
   consistently as severity markers across the codebase. Translate the words
   around them, keep the markers.

4. **Keep sentence case in UI copy**, not Title Case: "Download filters", not
   "Download Filters". Buttons too.

5. **No contractions in UI copy** — "do not", not "don't". Comments and logs may
   use them.

6. **Preserve line-length discipline.** Comment blocks are wrapped at roughly 80
   characters and several use box-drawing borders; keep them aligned after
   translating, and re-run `npm run format` at the end.

7. **AI prompts are not UI copy.** Translating a prompt changes model behaviour.
   They are handled deliberately, with
   `tests/backend/aiFilterPrompts.test.js` updated in the same change — never
   mechanically.

## 7. Things that stay in French

Nothing. Once the migration is done, `CLAUDE.md`'s "French UI copy and code
comments" convention is replaced by this file.
