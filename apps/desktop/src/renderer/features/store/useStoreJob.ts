import { useEffect, useState } from "react";
import type { AppRoute } from "../../app/routes";
import { storeJobOfRoute, type StoreDirection } from "./storeOperators";

// The job a store operator has picked, for the sidebar: none until they pick one on Store
// Station, then Move In or Move Out while they work that side.
//
// It follows the screen they are on. Opening a job (or any of its pages) selects that job;
// going back to Store Station — "Select Job" — clears it. Any other screen keeps the job
// they were on, so a detour does not empty the sidebar.

export const STORE_STATION_ROUTE: AppRoute = "store-home";

export const useStoreJob = (route: AppRoute): StoreDirection | null => {
  const [job, setJob] = useState<StoreDirection | null>(null);

  useEffect(() => {
    const opened = storeJobOfRoute(route);
    if (opened) setJob(opened);
    else if (route === STORE_STATION_ROUTE) setJob(null);
  }, [route]);

  return job;
};
