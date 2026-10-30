import { useCallback, useEffect, useRef, useState } from "react";
import { useProgramOut, type ProgramOutState } from "../programOut/useProgramOut";
import { useProgramCloseFor, type ProgramCloseState } from "../programClose/useProgramClose";

// THE STORE PAGE'S MACHINE PROGRAM (0.3.9): at most one open at a time, opened from the Machine
// programs pick-list, a sheet scanned into Scan out, or a notification. How it shows is the mode's:
// Receiving reads it and scans its cartons back in, Issuing issues against it.
//
// Packets issued against it ride this computer's open issue session when there is one, so they
// print on the same slip as everything else that left the store here.

export interface StoreProgram {
  program: ProgramOutState;
  close: ProgramCloseState;
  isOpen: boolean;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** Resolves a number, a sheet scan or an id; closes the pick-list once a program opens. */
  openProgram: (lookup: string) => void;
}

interface StoreProgramInput {
  token: string;
  /** This computer's open issue session, or null. */
  issueSessionId: string | null;
  /** A program to open on arrival (a notification): its stored id, still resolved by the main process. */
  initialProgramId?: string;
  onInitialProgramConsumed?: () => void;
}

export const useStoreProgram = ({ token, issueSessionId, initialProgramId, onInitialProgramConsumed }: StoreProgramInput): StoreProgram => {
  const program = useProgramOut({ token, sessionId: issueSessionId });
  const close = useProgramCloseFor(program);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { open } = program;

  const openProgram = useCallback(
    (lookup: string) => {
      void open(lookup).then((opened) => {
        if (opened) setDialogOpen(false);
      });
    },
    [open]
  );

  // A notification opens the program it names, once. Read through a ref: App passes an inline arrow.
  const openedFor = useRef<string | null>(null);
  const consumedRef = useRef(onInitialProgramConsumed);
  consumedRef.current = onInitialProgramConsumed;
  useEffect(() => {
    if (!initialProgramId || openedFor.current === initialProgramId) return;
    openedFor.current = initialProgramId;
    void open(initialProgramId).then(() => consumedRef.current?.());
  }, [initialProgramId, open]);

  return {
    program,
    close,
    isOpen: program.program !== null,
    dialogOpen,
    openDialog: () => setDialogOpen(true),
    closeDialog: () => setDialogOpen(false),
    openProgram,
  };
};
