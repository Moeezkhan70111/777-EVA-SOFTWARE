import { useEffect, useMemo, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { withoutIpcPrefix } from "../../utils/ipcError";
import { parsePartiesFromListReply, partiesFromText } from "./partiesFromList";

// The Paste parties dialog's state: the pasted text and what it reads as, the city and group, and the save. The main
// process checks the permission, the lease (PC1) and every name; this only sends what is shown in the preview.

export interface PartiesFromListOutcome {
  added: number;
  skipped: string[];
}

export const usePartiesFromList = (onAdded: (outcome: PartiesFromListOutcome) => void) => {
  const api = useDesktopApi();
  const [text, setText] = useState("");
  const [city, setCity] = useState("");
  const [groupName, setGroupName] = useState("");
  const [partyType, setPartyType] = useState("CUSTOMER");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cities, setCities] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const rows = useMemo(() => partiesFromText(text), [text]);

  useEffect(() => {
    void api.listCities().then(setCities).catch(() => setCities([]));
    void api.listPartyGroups().then((list) => setGroups(list.map((group) => group.groupName))).catch(() => setGroups([]));
  }, [api]);

  const save = async () => {
    if (!city.trim()) { setError(copy.partiesFromList.needCity); return; }
    setSaving(true);
    setError(null);
    try {
      const reply = parsePartiesFromListReply(await api.addPartiesFromList({ rows, city, groupName, partyType }));
      if (reply.ok) onAdded({ added: reply.created.length, skipped: reply.skipped });
      else setError(reply.reason);
    } catch (failure) {
      setError(leaseRefusalText(failure) ?? (failure instanceof Error ? withoutIpcPrefix(failure.message) : copy.partiesFromList.failed));
    } finally {
      setSaving(false);
    }
  };

  return { text, setText, city, setCity, groupName, setGroupName, partyType, setPartyType, rows, cities, groups, saving, error, save };
};
