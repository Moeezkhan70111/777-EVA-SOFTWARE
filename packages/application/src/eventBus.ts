export type EventHandler<TPayload> = (payload: TPayload) => Promise<void> | void;

export class InMemoryEventBus {
  private readonly handlers = new Map<string, EventHandler<unknown>[]>();

  subscribe<TPayload>(eventName: string, handler: EventHandler<TPayload>): () => void {
    const existing = this.handlers.get(eventName) ?? [];
    this.handlers.set(eventName, [...existing, handler as EventHandler<unknown>]);

    return () => {
      const current = this.handlers.get(eventName) ?? [];
      this.handlers.set(
        eventName,
        current.filter((item) => item !== (handler as EventHandler<unknown>))
      );
    };
  }

  async publish<TPayload>(eventName: string, payload: TPayload): Promise<void> {
    const handlers = this.handlers.get(eventName) ?? [];
    for (const handler of handlers) {
      await handler(payload as unknown);
    }
  }
}
