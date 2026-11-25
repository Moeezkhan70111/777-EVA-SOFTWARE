// HOW FAR TODAY HAS GOT (owner, 25 Nov 2026: goal gradient and the Zeigarnik effect): which machines have
// production saved today and which are still to come. Read from what the main process says was saved
// (productionDayView), never from the list still waiting to be saved. "Complete today's production" stays the
// operator's decision: this only says where the day stands.

export interface MachineName {
  readonly id: string;
  readonly name: string;
}

export interface DayProgress {
  /** Machines with production saved today, in the machines' own order. */
  readonly done: readonly MachineName[];
  /** Machines with nothing saved today yet. */
  readonly missing: readonly MachineName[];
  /** Saved dozens per machine id, for the machine cards. */
  readonly cartonsByMachine: ReadonlyMap<string, number>;
}

export function dayProgress(machines: readonly MachineName[], saved: ReadonlyArray<{ readonly machineName: string; readonly cartons: number }>): DayProgress {
  const savedByName = new Map(saved.filter((machine) => machine.cartons > 0).map((machine) => [machine.machineName, machine.cartons]));
  const cartonsByMachine = new Map<string, number>();
  for (const machine of machines) {
    const cartons = savedByName.get(machine.name);
    if (cartons !== undefined) cartonsByMachine.set(machine.id, cartons);
  }
  return {
    done: machines.filter((machine) => cartonsByMachine.has(machine.id)),
    missing: machines.filter((machine) => !cartonsByMachine.has(machine.id)),
    cartonsByMachine,
  };
}
