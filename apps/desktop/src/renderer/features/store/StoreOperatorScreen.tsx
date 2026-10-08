import React from "react";
import { copy } from "../../config/copy";
import { storeOperator, type StoreDirection } from "./storeOperators";
import { StoreTopBar } from "./StoreTopBar";

// Where a store operator works once they have picked their job. One screen serves both
// directions — the head names the job, and the job's own cards go in the body.
//
// A job whose steps are not built yet passes no cards, and the screen says so.

interface StoreOperatorScreenProps {
  direction: StoreDirection;
  onBack: () => void;
  /** The job's action cards. Left out while that job is still being built. */
  children?: React.ReactNode;
}

export const StoreOperatorScreen: React.FC<StoreOperatorScreenProps> = ({ direction, onBack, children }) => {
  const operator = storeOperator(direction);
  return (
    <div className={`so-page so-screen so-screen--${direction}`}>
      <StoreTopBar
        title={operator.title}
        subtitle={copy.store.operator}
        tone={direction}
        back={{ label: copy.store.changeJob, onClick: onBack }}
      />

      <main className="so-screen-body">
        {children ? <div className="so-actions">{children}</div> : <p className="so-screen-empty">{copy.store.comingNext}</p>}
      </main>
    </div>
  );
};
