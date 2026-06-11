import { BuiltInPrograms } from '@/models/built-in-programs';
import { RemoteData } from '@/models/remote';
import { ProgramBlueprint } from '@/models/blueprint-models';
import { AddEffectFn, RootState } from '@/store/store';
import { showSnackbar } from '@/store/app';
import {
  fetchUpcomingSessions,
  importProgramFromFile,
  importProgramFromJson,
  initializeProgramStateSlice,
  saveProgram,
  saveProgramAndSetActive,
  selectActiveProgram,
  setActiveProgram,
  setIsHydrated,
  setSavedPrograms,
  setUpcomingSessions,
} from '@/store/program';
import { uuid } from '@/utils/uuid';
import { AsyncStream } from 'data-async-iterators';
import { Logger } from '@/services/logger';
import { selectLatestExercises } from '../stored-sessions';
import { programsSchema } from '@/db/schema';
import {
  LatestVersion,
  ProgramBlueprintJSON,
  toLocalDateJSON,
} from '@/models/storage/versions/latest';
import { LocalDate } from '@js-joda/core';
import { toRecord } from '@/utils/reduce';
import { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { TaskAbortError } from '@reduxjs/toolkit';

const builtInProgramsStorageKey = 'hasSavedDefaultPlans2';
export function applyProgramEffects(addEffect: AddEffectFn) {
  addEffect(
    initializeProgramStateSlice,
    async (
      _,
      {
        getState,
        cancelActiveListeners,
        dispatch,
        extra: { keyValueStore, logger, db },
        throwIfCancelled,
      },
    ) => {
      const start = performance.now();
      cancelActiveListeners();

      let activeProgramId: string | undefined;
      const dbPrograms = await db.select().from(programsSchema);
      const programs = (
        dbPrograms.length ? dbPrograms : [getEmptyInitialProgram()]
      ).reduce(
        toRecord(
          (x) => x.id,
          (row) => {
            if (row.active) {
              activeProgramId = row.id;
            }
            return ProgramBlueprint.fromJSON(row.payload);
          },
        ),
        {},
      );
      dispatch(setSavedPrograms(programs));

      if (!(await keyValueStore.getItem(builtInProgramsStorageKey))) {
        for (const [id, program] of Object.entries(BuiltInPrograms)) {
          if (id in getState().program.savedPrograms) {
            continue;
          }
          dispatch(saveProgram({ programId: id, programBlueprint: program }));
        }
        await persistPrograms(getState(), db, logger, throwIfCancelled);
        await keyValueStore.setItem(builtInProgramsStorageKey, 'true');
      }
      if (!activeProgramId || !getState().program.savedPrograms[activeProgramId]) {
        activeProgramId = Object.keys(getState().program.savedPrograms)[0]!;
      }

      dispatch(setActiveProgram({ activeProgramId }));

      dispatch(setIsHydrated(true));
      const end = performance.now();
      logger.info(
        `initializeProgramStateSlice effect took ${(end - start).toFixed(2)} ms`,
      );
    },
  );

  // Persist after changes
  addEffect(
    undefined,
    async (
      _,
      {
        stateBeforeReduce,
        stateAfterReduce,
        extra: { db, logger },
        throwIfCancelled,
        cancelActiveListeners,
      },
    ) => {
      cancelActiveListeners();
      const start = performance.now();
      const shouldPersist =
        stateAfterReduce.program.isHydrated &&
        (stateAfterReduce.program.activeProgramId !==
          stateBeforeReduce.program.activeProgramId ||
          stateAfterReduce.program.savedPrograms !==
            stateBeforeReduce.program.savedPrograms);
      if (shouldPersist) {
        await persistPrograms(stateAfterReduce, db, logger, throwIfCancelled);
        const end = performance.now();
        logger.info(
          `Persist program state effect took ${(end - start).toFixed(2)} ms`,
        );
      }
    },
  );

  addEffect(
    fetchUpcomingSessions,
    async (
      _,
      {
        signal,
        cancelActiveListeners,
        dispatch,
        getState,
        extra: { sessionService, logger },
      },
    ) => {
      const start = performance.now();
      cancelActiveListeners();
      await yieldToEventLoop();

      const state = getState();
      const sessionBlueprints = selectActiveProgram(state).sessions;
      const numberOfUpcomingSessions = sessionBlueprints.length;

      if (signal.aborted) {
        return;
      }
      await yieldToEventLoop();

      const sessions = await AsyncStream.from(
        sessionService.getUpcomingSessions(
          sessionBlueprints,
          selectLatestExercises(state),
        ),
      )
        .takeWhile(() => !signal.aborted)
        .take(numberOfUpcomingSessions)
        .toArray();
      dispatch(setUpcomingSessions(RemoteData.success(sessions)));
      const end = performance.now();
      logger.info(
        `fetchUpcomingSessions effect took ${(end - start).toFixed(2)} ms`,
      );
    },
  );

  addEffect(
    importProgramFromFile,
    async (_, { dispatch, extra: { filePickerService, tolgee, logger } }) => {
      const file = await filePickerService.pickFile();
      if (!file) {
        return;
      }

      try {
        const text = new TextDecoder().decode(file.bytes);
        dispatch(importProgramFromJson({ json: JSON.parse(text) }));
      } catch (error) {
        logger.warn('Failed to parse imported workout plan file', { error });
        dispatch(
          showSnackbar({ text: tolgee.t('plan.import.invalid_file.message') }),
        );
      }
    },
  );

  addEffect(
    importProgramFromJson,
    async (
      { payload: { json } },
      { dispatch, getState, extra: { tolgee, logger } },
    ) => {
      try {
        const importedProgram = parseImportedProgramJson(json);
        const trimmedName = importedProgram.name.trim();
        if (!trimmedName) {
          throw new InvalidProgramImportError('Plan name is empty after trimming');
        }

        const existingProgramNames = Object.values(getState().program.savedPrograms)
          .map((program) => program.name)
          .filter((name) => !!name.trim());
        const uniqueName = getUniqueImportedProgramName(
          existingProgramNames,
          trimmedName,
        );

        let programId = uuid();
        while (programId in getState().program.savedPrograms) {
          programId = uuid();
        }
        dispatch(
          saveProgramAndSetActive({
            programId,
            programBlueprint: importedProgram.with({ name: uniqueName }),
          }),
        );
        dispatch(showSnackbar({ text: tolgee.t('plan.import.success.message') }));
      } catch (error) {
        if (error instanceof UnsupportedProgramImportFormatError) {
          dispatch(
            showSnackbar({
              text: tolgee.t('plan.import.unsupported_format.message'),
            }),
          );
          return;
        }
        if (error instanceof InvalidProgramImportError) {
          dispatch(
            showSnackbar({ text: tolgee.t('plan.import.invalid_file.message') }),
          );
          return;
        }
        logger.error('Unexpected failure while importing workout plan', error);
        dispatch(showSnackbar({ text: tolgee.t('plan.import.failed.message') }));
      }
    },
  );
}
// Helper function to yield control back to the event loop
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 5));

class UnsupportedProgramImportFormatError extends Error {}
class InvalidProgramImportError extends Error {}

function parseImportedProgramJson(json: unknown): ProgramBlueprint {
  if (!json || typeof json !== 'object') {
    throw new InvalidProgramImportError('JSON root is not an object');
  }

  const parsed = json as Record<string, unknown>;
  if ('type' in parsed || 'formatVersion' in parsed || 'program' in parsed) {
    if (
      parsed.type !== 'LiftLogPlanExport' ||
      parsed.formatVersion !== 1 ||
      !parsed.program
    ) {
      throw new UnsupportedProgramImportFormatError(
        'Unsupported LiftLogPlanExport wrapper format',
      );
    }
    return tryParseProgramBlueprintJson(parsed.program as ProgramBlueprintJSON);
  }

  return tryParseProgramBlueprintJson(json as ProgramBlueprintJSON);
}

function tryParseProgramBlueprintJson(
  json: ProgramBlueprintJSON,
): ProgramBlueprint {
  try {
    return ProgramBlueprint.fromJSON(json);
  } catch {
    throw new InvalidProgramImportError('Invalid ProgramBlueprintJSON payload');
  }
}

function getUniqueImportedProgramName(
  existingNames: readonly string[],
  importedName: string,
): string {
  const normalizedExistingNames = new Set(
    existingNames.map((name) => name.trim().toLocaleLowerCase()),
  );
  if (!normalizedExistingNames.has(importedName.toLocaleLowerCase())) {
    return importedName;
  }

  const firstImportedName = `${importedName} (Imported)`;
  if (!normalizedExistingNames.has(firstImportedName.toLocaleLowerCase())) {
    return firstImportedName;
  }

  let suffix = 2;
  while (normalizedExistingNames.has(
    `${importedName} (Imported ${suffix})`.toLocaleLowerCase(),
  )) {
    suffix += 1;
  }
  return `${importedName} (Imported ${suffix})`;
}

async function persistPrograms(
  stateAfterReduce: RootState,
  db: ExpoSQLiteDatabase,
  logger: Logger,
  throwIfCancelled: () => void,
) {
  try {
    await db.transaction(async (tx) => {
      throwIfCancelled();
      await tx.delete(programsSchema);
      await tx.insert(programsSchema).values(
        Object.entries(stateAfterReduce.program.savedPrograms).map(
          ([key, program]) => ({
            id: key,
            modelVersion: LatestVersion,
            active: key === stateAfterReduce.program.activeProgramId,
            payload: ProgramBlueprint.fromPOJO(program).toJSON(),
          }),
        ),
      );
      throwIfCancelled();
    });
  } catch (e) {
    if (e instanceof TaskAbortError) {
      return;
    }
    logger.error('Failed to persist program state', e);
  }
}

function getEmptyInitialProgram(): typeof programsSchema.$inferSelect {
  return {
    id: uuid(),
    modelVersion: LatestVersion,
    active: true,
    payload: {
      lastEdited: toLocalDateJSON(LocalDate.now()),
      name: 'My Program',
      sessions: [],
    },
  };
}
