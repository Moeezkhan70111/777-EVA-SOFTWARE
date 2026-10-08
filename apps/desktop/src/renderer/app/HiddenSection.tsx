import React from "react";

// Shown in place of a section that hasn't been brought back into the visible
// app yet during the UI rebuild. The underlying page component still exists
// and is untouched — see ./visibleSections.
export const HiddenSection = () => (
  <div className="state-view" role="status">
    <span className="state-view-hint">This section is hidden while the interface is being rebuilt.</span>
  </div>
);
