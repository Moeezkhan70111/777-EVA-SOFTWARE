// The colour list: English colour -> what the factory floor calls it in Urdu (docs/45).
//
// Reading it needs a signed-in user: every screen that shows a colour in Urdu reads it. Changing it is master-data
// setup, so it needs Settings or Raw Material Setup -- checked here, because hiding the page is not authorisation --
// and the MASTER_DATA lease, checked first by the write gate (leaseChannels.ts).

// Leased channels pass the write gate first (leaseGuard.ts, leaseChannels.ts).
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, asRecord, asString } from "@erp/domain";
import { ColorTranslationRefusedError, type ColorTranslationInput } from "@erp/data";
import { rejection } from "../authorize";

/** The same people who keep the material catalogue in order (rawMaterials.ts, RAW_MATERIAL_SETUP_ACCESS). */
const COLOR_LIST_ACCESS = [PERMISSION.SETTINGS, PERMISSION.RAW_MATERIAL_SETUP] as const;

const inputOf = (value: unknown): ColorTranslationInput => {
  const record = asRecord(value);
  return { englishName: asString(record.englishName), urduName: asString(record.urduName) };
};

/** A refusal the screen can name: the data layer's code, or the authoriser's. */
const refused = (error: unknown) =>
  error instanceof ColorTranslationRefusedError ? { accepted: false as const, reason: error.message, code: error.code } : rejection(error, "The colour could not be saved.");

export function registerColorTranslationHandlers(ctx: IpcContext): void {
  const { db, authorizer } = ctx;

  ipcMain.handle(IPC.listColorTranslations, (event) => {
    try {
      authorizer.requireUser(event);
      return { accepted: true, translations: db.listColorTranslations() };
    } catch (error) {
      return rejection(error, "The colour list could not be read.");
    }
  });

  ipcMain.handle(IPC.createColorTranslation, (event, input?: unknown) => {
    try {
      authorizer.requireAnyPermission(event, COLOR_LIST_ACCESS);
      return { accepted: true, translation: db.createColorTranslation(inputOf(input)) };
    } catch (error) {
      return refused(error);
    }
  });

  ipcMain.handle(IPC.updateColorTranslation, (event, id?: unknown, input?: unknown) => {
    try {
      authorizer.requireAnyPermission(event, COLOR_LIST_ACCESS);
      return { accepted: true, translation: db.updateColorTranslation(asString(id), inputOf(input)) };
    } catch (error) {
      return refused(error);
    }
  });

  ipcMain.handle(IPC.deleteColorTranslation, (event, id?: unknown) => {
    try {
      authorizer.requireAnyPermission(event, COLOR_LIST_ACCESS);
      db.deleteColorTranslation(asString(id));
      return { accepted: true };
    } catch (error) {
      return refused(error);
    }
  });
}
