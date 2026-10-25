/// <reference path="../types/global.d.ts" />
import React, { useEffect, useState } from "react";
import type { AppRoute } from "../app/routes";
import { copy } from "../config/copy";
import { UrduInput } from "../components/shared/UrduInput";
import { learnUrduWords, transliterateWithLearnedWords } from "../utils/urdu";
import { LEASE_DOMAIN } from "@erp/domain";
import { LeaseNotices } from "../features/sync/LeaseNotices";

/** Parties and machines are master data: written on one computer, read on the others (docs/37 section W). */
const MASTER_DATA_ONLY = [LEASE_DOMAIN.MASTER_DATA] as const;

const MAJOR_PAKISTAN_CITIES = [
  "Karachi",
  "Lahore",
  "Faisalabad",
  "Rawalpindi",
  "Islamabad",
  "Multan",
  "Peshawar",
  "Quetta",
  "Sialkot",
  "Gujranwala",
  "Bahawalpur",
  "Sargodha",
  "Sheikhupura",
  "Sahiwal",
  "Hyderabad",
  "Sukkur",
  "Abbottabad",
  "Mardan",
  "Mingora",
  "Okara",
  "Kasur",
  "Jhelum",
  "Gujrat",
  "Rahim Yar Khan",
  "Dera Ghazi Khan",
];

const PARTY_GROUPS = [
  "Wholesale",
  "Retail",
  "Distributor",
  "Dealer",
  "VIP",
  "Export",
  "Local",
  "Schools",
  "Government",
  "Factories",
  "Hospitals",
];

interface PartyFormData {
  partyCode: string;
  partyName: string;
  partyNameUrdu: string;
  partyType: string;
  contactPerson: string;
  mobileNumber: string;
  whatsAppNumber: string;
  phoneNumber: string;
  email: string;
  address: string;
  city: string;
  partyGroupId: string;
  remarks: string;
  status: string;
  balanceLimit: string; // stored as string in form, converted to number/null on submit
}

interface PartyGroup {
  id: string;
  groupName: string;
}

const PARTY_TYPES: Array<{ value: string; label: string }> = [
  { value: "CUSTOMER", label: copy.columns.customer },
  { value: "SUPPLIER", label: copy.columns.supplier },
  { value: "CONTRACTOR", label: "Contractor" },
  { value: "DISTRIBUTOR", label: "Distributor" },
  { value: "DEALER", label: "Dealer" },
  { value: "TRANSPORTER", label: "Transporter" },
];

interface PartyFormPageProps {
  partyId?: string;
  onNavigate: (route: AppRoute) => void;
}

export const PartyFormPage: React.FC<PartyFormPageProps> = ({ partyId, onNavigate }) => {
  const [formData, setFormData] = useState<PartyFormData>({
    partyCode: "",
    partyName: "",
    partyNameUrdu: "",
    partyType: "CUSTOMER",
    contactPerson: "",
    mobileNumber: "",
    whatsAppNumber: "",
    phoneNumber: "",
    email: "",
    address: "",
    city: "",
    partyGroupId: "",
    remarks: "",
    status: "ACTIVE",
    balanceLimit: "",
  });

  const [groups, setGroups] = useState<PartyGroup[]>([]);
  const [cities, setCities] = useState<string[]>(MAJOR_PAKISTAN_CITIES);
  const [filteredCities, setFilteredCities] = useState<string[]>(MAJOR_PAKISTAN_CITIES);
  const [isCityMenuOpen, setIsCityMenuOpen] = useState(false);
  const [highlightedCityIndex, setHighlightedCityIndex] = useState(0);
  const [groupQuery, setGroupQuery] = useState("");
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const [highlightedGroupIndex, setHighlightedGroupIndex] = useState(0);
  // party type combobox
  const [partyTypeQuery, setPartyTypeQuery] = useState("");
  const [isPartyTypeMenuOpen, setIsPartyTypeMenuOpen] = useState(false);
  const [highlightedPartyTypeIndex, setHighlightedPartyTypeIndex] = useState(0);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [urduNameEdited, setUrduNameEdited] = useState(false);

  useEffect(() => {
    loadGroupsAndCities();
    if (partyId) {
      loadParty();
    } else {
      void window.desktop.api.getNextPartyCode().then((partyCode) => {
        setFormData((prev) => ({ ...prev, partyCode }));
      });
    }
  }, [partyId]);

  const loadGroupsAndCities = async () => {
    try {
      const groupsResult = await window.desktop.api.listPartyGroups();
      setGroups(groupsResult);

      const citiesResult = await window.desktop.api.listCities();
      const allCities = [...new Set([...MAJOR_PAKISTAN_CITIES, ...citiesResult])].sort();
      setCities(allCities);
      setFilteredCities(allCities);
    } catch (error) {
      console.error("Failed to load groups and cities:", error);
    }
  };

  const loadParty = async () => {
    if (!partyId) return;
    try {
      setLoading(true);
      const party = await window.desktop.api.getParty(partyId);
      if (party) {
        setFormData({
          partyCode: party.partyCode,
          partyName: party.partyName,
          partyNameUrdu: party.partyNameUrdu || "",
          partyType: party.partyType || "CUSTOMER",
          contactPerson: party.contactPerson || "",
          mobileNumber: party.mobileNumber || "",
          whatsAppNumber: party.whatsAppNumber || "",
          phoneNumber: party.phoneNumber || "",
          email: party.email || "",
          address: party.address || "",
          city: party.city || "",
          partyGroupId: party.partyGroupId || "",
          remarks: party.remarks || "",
          status: party.status || "ACTIVE",
          balanceLimit: party.balanceLimit != null ? String(party.balanceLimit) : "",
        });
        setUrduNameEdited(Boolean(party.partyNameUrdu));
      }
    } catch (error) {
      console.error("Failed to load party:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field: keyof PartyFormData, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    // Clear error for this field
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handlePartyNameChange = (value: string) => {
    handleInputChange("partyName", value);
    if (!urduNameEdited) {
      handleInputChange("partyNameUrdu", transliterateWithLearnedWords(value));
    }
  };

  const handlePartyNameUrduChange = (value: string) => {
    setUrduNameEdited(true);
    handleInputChange("partyNameUrdu", value);
  };

  const handlePartyNameUrduBlur = () => {
    learnUrduWords(formData.partyName, formData.partyNameUrdu);
  };

  const handleCityChange = (value: string) => {
    handleInputChange("city", value);
    setIsCityMenuOpen(true);
    setHighlightedCityIndex(0);
    if (value) {
      const filtered = cities.filter((c) => c.toLowerCase().includes(value.toLowerCase()));
      setFilteredCities(filtered);
    } else {
      setFilteredCities(cities);
    }
  };

  const handleCitySelect = (city: string) => {
    handleInputChange("city", city);
    setFilteredCities(cities);
    setIsCityMenuOpen(false);
    setHighlightedCityIndex(0);
  };

  const handleCityKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isCityMenuOpen) setIsCityMenuOpen(true);
      setHighlightedCityIndex((index) => Math.min(index + 1, filteredCities.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedCityIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && isCityMenuOpen && filteredCities.length > 0) {
      event.preventDefault();
      handleCitySelect(filteredCities[highlightedCityIndex] ?? filteredCities[0]);
      return;
    }
    if (event.key === "Escape") {
      setIsCityMenuOpen(false);
    }
  };

  const matchingGroups = groups.filter((group) =>
    group.groupName.toLowerCase().includes(groupQuery.trim().toLowerCase()),
  );

  const filteredPartyTypes = PARTY_TYPES.filter((t) =>
    t.label.toLowerCase().includes(partyTypeQuery.trim().toLowerCase()),
  );

  const handlePartyTypeSelect = (value: string) => {
    handleInputChange("partyType", value);
    setPartyTypeQuery("");
    setIsPartyTypeMenuOpen(false);
    setHighlightedPartyTypeIndex(0);
  };

  const handlePartyTypeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsPartyTypeMenuOpen(true);
      setHighlightedPartyTypeIndex((i) => Math.min(i + 1, filteredPartyTypes.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedPartyTypeIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter" && isPartyTypeMenuOpen && filteredPartyTypes.length > 0) {
      event.preventDefault();
      handlePartyTypeSelect((filteredPartyTypes[highlightedPartyTypeIndex] ?? filteredPartyTypes[0]).value);
      return;
    }
    if (event.key === "Escape") setIsPartyTypeMenuOpen(false);
  };

  const handleGroupSelect = (group: PartyGroup) => {
    handleInputChange("partyGroupId", group.id);
    setGroupQuery("");
    setIsGroupMenuOpen(false);
    setHighlightedGroupIndex(0);
  };

  const handleGroupKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsGroupMenuOpen(true);
      setHighlightedGroupIndex((index) => Math.min(index + 1, matchingGroups.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedGroupIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && isGroupMenuOpen && matchingGroups.length > 0) {
      event.preventDefault();
      handleGroupSelect(matchingGroups[highlightedGroupIndex] ?? matchingGroups[0]);
      return;
    }
    if (event.key === "Escape") setIsGroupMenuOpen(false);
  };

  const handleAddGroup = async () => {
    if (!newGroupName.trim()) {
      return;
    }

    try {
      const result = await window.desktop.api.createPartyGroup({
        groupName: newGroupName.trim(),
      });

      if (result.accepted) {
        // Reload groups
        await loadGroupsAndCities();
        // Auto-select the new group
        setFormData((prev) => ({
          ...prev,
          partyGroupId: result.groupId || "",
        }));
        setShowAddGroup(false);
        setNewGroupName("");
      } else {
        alert(result.reason || "Failed to create group");
      }
    } catch (error) {
      console.error("Failed to create group:", error);
      alert("Error creating group");
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.partyName.trim()) {
      newErrors.partyName = "Party name is required";
    }
    if (!formData.city.trim()) {
      newErrors.city = "City is required";
    }
    if (!formData.partyGroupId) {
      newErrors.partyGroupId = "Party group is required";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      setSubmitted(true);
      return;
    }

    try {
      setLoading(true);

      // Convert balanceLimit string → number | null
      const balanceLimitValue = formData.balanceLimit.trim() !== ""
        ? parseFloat(formData.balanceLimit)
        : null;

      const payload = {
        ...formData,
        balanceLimit: balanceLimitValue != null && Number.isFinite(balanceLimitValue)
          ? balanceLimitValue
          : null,
      };

      let result;
      if (partyId) {
        result = await window.desktop.api.updateParty({
          id: partyId,
          ...payload,
        } as unknown as Record<string, unknown>);
      } else {
        result = await window.desktop.api.createParty(payload as unknown as Record<string, unknown>);
      }

      if (result.accepted) {
        alert(partyId ? "Party updated successfully" : "Party created successfully");
        onNavigate("party-list");
      } else {
        alert(result.reason || "Operation failed");
      }
    } catch (error) {
      console.error("Form submission error:", error);
      alert("Error processing request");
    } finally {
      setLoading(false);
    }
  };

  // Save current party, then reset the form so the user can add another (quick-add "+").
  const handleQuickAddParty = async () => {
    if (partyId) return; // only meaningful for new parties
    if (!validateForm()) { setSubmitted(true); return; }
    try {
      setLoading(true);
      const balanceLimitValue = formData.balanceLimit.trim() !== "" ? parseFloat(formData.balanceLimit) : null;
      const payload = { ...formData, balanceLimit: balanceLimitValue != null && Number.isFinite(balanceLimitValue) ? balanceLimitValue : null };
      const result = await window.desktop.api.createParty(payload as unknown as Record<string, unknown>);
      if (!result.accepted) { alert(result.reason || "Operation failed"); return; }
      // Reset for the next party, keeping the chosen type for fast repeated entry.
      const nextCode = await window.desktop.api.getNextPartyCode();
      setFormData({
        partyCode: nextCode,
        partyName: "",
        partyNameUrdu: "",
        partyType: formData.partyType,
        contactPerson: "",
        mobileNumber: "",
        whatsAppNumber: "",
        phoneNumber: "",
        email: "",
        address: "",
        city: formData.city,
        partyGroupId: formData.partyGroupId,
        remarks: "",
        status: "ACTIVE",
        balanceLimit: "",
      });
      setUrduNameEdited(false);
      setSubmitted(false);
      setErrors({});
      alert("Party saved. Add another.");
    } catch (error) {
      console.error("Quick-add error:", error);
      alert("Error processing request");
    } finally {
      setLoading(false);
    }
  };

  if (loading && partyId) {
    return <div className="page loading">Loading party...</div>;
  }

  return (
    <div className="page party-form-page">
      <LeaseNotices domains={MASTER_DATA_ONLY} />
      <div className="party-form-heading">
        <div className="headingAddParty">
        
        <h1>{partyId ? "Edit Party" : "Add New Party"}</h1>
         {!partyId && <p>Create a new party to manage transactions and balances.</p>}
         </div>
         <button type="button" className="party-back-link" onClick={() => onNavigate("party-list")}>
          <span aria-hidden="true">←</span> Back to List
        </button>
      </div>
        
       

      <form onSubmit={handleSubmit} className="party-form party-form-layout">
        <section className="party-form-card party-basic-card">
          <h2>Basic Information</h2>

          <div className="form-group party-code-field">
            <label htmlFor="partyCode">Party Code</label>
            <input id="partyCode" type="text" className="form-input" value={formData.partyCode || "Generating..."} readOnly aria-readonly="true" />
            <span className="field-help">Automatically generated unique identifier</span>
          </div>

          <div className="form-group">
            <label htmlFor="partyType">Party Type <span className="required-mark">*</span></label>
            <div className="city-combobox">
              <span className="city-search-icon" aria-hidden="true">⌕</span>
              <input
                id="partyType"
                type="text"
                className="form-input"
                value={
                  isPartyTypeMenuOpen
                    ? partyTypeQuery
                    : (PARTY_TYPES.find((t) => t.value === formData.partyType)?.label ?? "")
                }
                onChange={(e) => {
                  setPartyTypeQuery(e.target.value);
                  if (formData.partyType) handleInputChange("partyType", "");
                  setIsPartyTypeMenuOpen(true);
                  setHighlightedPartyTypeIndex(0);
                }}
                onFocus={(e) => { e.currentTarget.select(); setIsPartyTypeMenuOpen(true); }}
                onBlur={() => window.setTimeout(() => setIsPartyTypeMenuOpen(false), 120)}
                onKeyDown={handlePartyTypeKeyDown}
                placeholder="Select party type"
                role="combobox"
                aria-expanded={isPartyTypeMenuOpen}
                aria-autocomplete="list"
                autoComplete="off"
              />
              {isPartyTypeMenuOpen && (
                <div className="city-options" role="listbox">
                  {filteredPartyTypes.length === 0 ? (
                    <div className="city-options-empty" role="status">No types found</div>
                  ) : filteredPartyTypes.map((t, index) => (
                    <button
                      key={t.value}
                      type="button"
                      className={`city-option${(index === highlightedPartyTypeIndex || t.value === formData.partyType) ? " highlighted" : ""}`}
                      role="option"
                      aria-selected={t.value === formData.partyType}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handlePartyTypeSelect(t.value)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="field-help">Customer, supplier, contractor, etc.</span>
          </div>

          <div className="form-group party-name-field">
            <label htmlFor="partyName">Party Name <span className="required-mark">*</span></label>
            <input
              id="partyName"
              type="text"
              className={`form-input ${errors.partyName ? "error" : ""}`}
              value={formData.partyName}
              onChange={(e) => handlePartyNameChange(e.target.value)}
              placeholder="Enter party name"
              required
            />
            {errors.partyName && <span className="error-message">{errors.partyName}</span>}
          </div>

          <div className="form-group party-name-urdu-field">
            <label htmlFor="partyNameUrdu">Party Name (Urdu)</label>
            <UrduInput
              id="partyNameUrdu"
              value={formData.partyNameUrdu}
              onChange={handlePartyNameUrduChange}
              onBlur={handlePartyNameUrduBlur}
              placeholder="اردو میں نام"
            />
            <span className="field-help">Auto-translated. You can edit this name.</span>
          </div>

          <div className="form-row party-two-column">
            <div className="form-group">
              <label htmlFor="contactPerson">Contact Person</label>
              <input
                id="contactPerson"
                type="text"
                className="form-input"
                value={formData.contactPerson}
                onChange={(e) => handleInputChange("contactPerson", e.target.value)}
                placeholder="Contact person name"
              />
            </div>
            <div className="form-group">
              <label htmlFor="city">{copy.columns.city}<span className="required-mark">*</span></label>
              <div className="city-combobox">
                <span className="city-search-icon" aria-hidden="true">⌕</span>
                <input
                  id="city"
                  type="text"
                  className="form-input autocomplete"
                  value={formData.city}
                  onChange={(e) => handleCityChange(e.target.value)}
                  onFocus={() => setIsCityMenuOpen(true)}
                  onBlur={() => window.setTimeout(() => setIsCityMenuOpen(false), 120)}
                  onKeyDown={handleCityKeyDown}
                  aria-invalid={Boolean(errors.city)}
                  placeholder="Select or type city"
                  role="combobox"
                  aria-expanded={isCityMenuOpen}
                  aria-controls="city-options"
                  aria-autocomplete="list"
                  aria-activedescendant={isCityMenuOpen && filteredCities[highlightedCityIndex] ? `city-option-${highlightedCityIndex}` : undefined}
                  autoComplete="off"
                />
                {isCityMenuOpen && (
                  <div id="city-options" className="city-options" role="listbox">
                    {filteredCities.length === 0 ? (
                      <div className="city-options-empty" role="status">No cities found</div>
                    ) : filteredCities.map((city, index) => (
                      <button
                        key={city}
                        id={`city-option-${index}`}
                        type="button"
                        className={`city-option${index === highlightedCityIndex ? " highlighted" : ""}`}
                        role="option"
                        aria-selected={index === highlightedCityIndex}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleCitySelect(city)}
                      >
                        {city}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {errors.city && <span className="error-message">{errors.city}</span>}
            </div>
          </div>

          <div className="form-row party-two-column">
            <div className="form-group party-wide-field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="form-input"
                value={formData.email}
                onChange={(e) => handleInputChange("email", e.target.value)}
                placeholder="email@example.com"
              />
            </div>
          </div>

          <div className="form-row party-two-column party-phone-row">
            <div className="form-group">
              <label htmlFor="mobileNumber">Mobile Number</label>
              <input
                id="mobileNumber"
                type="tel"
                className="form-input"
                value={formData.mobileNumber}
                onChange={(e) => handleInputChange("mobileNumber", e.target.value)}
                placeholder="+92 300 1234567"
              />
            </div>
            <div className="form-group">
              <label htmlFor="whatsAppNumber">WhatsApp Number</label>
              <input
                id="whatsAppNumber"
                type="tel"
                className="form-input"
                value={formData.whatsAppNumber}
                onChange={(e) => handleInputChange("whatsAppNumber", e.target.value)}
                placeholder="+92 300 1234567"
              />
            </div>
            <div className="form-group">
              <label htmlFor="phoneNumber">Phone Number</label>
              <input
                id="phoneNumber"
                type="tel"
                className="form-input"
                value={formData.phoneNumber}
                onChange={(e) => handleInputChange("phoneNumber", e.target.value)}
                placeholder="+92 42 1234567"
              />
            </div>
          </div>

          <div className="form-group party-wide-field">
            <label htmlFor="address">Address</label>
            <textarea
              id="address"
              className="form-input"
              rows={3}
              value={formData.address}
              onChange={(e) => handleInputChange("address", e.target.value)}
              placeholder="Full address"
            />
          </div>
        </section>

        <section className="party-form-card party-organization-card">
          <h2>Organization / Party Details</h2>

          <div className="form-group">
              <label htmlFor="partyGroupId">Party Group <span className="required-mark">*</span></label>
              <div className="input-with-button party-group-combobox-wrap">
                <div className="city-combobox party-group-combobox">
                  <span className="city-search-icon" aria-hidden="true">⌕</span>
                  <input
                  id="partyGroupId"
                  className="form-input"
                  value={groupQuery || groups.find((group) => group.id === formData.partyGroupId)?.groupName || ""}
                  onChange={(event) => {
                    setGroupQuery(event.target.value);
                    if (formData.partyGroupId) handleInputChange("partyGroupId", "");
                    setIsGroupMenuOpen(true);
                    setHighlightedGroupIndex(0);
                  }}
                  onFocus={(event) => { event.currentTarget.select(); setIsGroupMenuOpen(true); }}
                  onBlur={() => window.setTimeout(() => setIsGroupMenuOpen(false), 120)}
                  onKeyDown={handleGroupKeyDown}
                  placeholder="Search or select group"
                  role="combobox"
                  aria-expanded={isGroupMenuOpen}
                  aria-controls="party-group-options"
                  aria-autocomplete="list"
                  aria-invalid={Boolean(errors.partyGroupId)}
                  autoComplete="off"
                />
                {isGroupMenuOpen && (
                  <div id="party-group-options" className="city-options" role="listbox">
                    {matchingGroups.length === 0 ? (
                      <div className="city-options-empty" role="status">{copy.empty.noGroups}</div>
                    ) : matchingGroups.map((group, index) => (
                      <button
                        key={group.id}
                        type="button"
                        className={`city-option${index === highlightedGroupIndex ? " highlighted" : ""}`}
                        role="option"
                        aria-selected={group.id === formData.partyGroupId}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleGroupSelect(group)}
                      >
                        {group.groupName}
                      </button>
                    ))}
                  </div>
                )}
                </div>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Add new group"
                  onClick={() => setShowAddGroup(true)}
                >
                  +
                </button>
              </div>
              {errors.partyGroupId && <span className="error-message">{errors.partyGroupId}</span>}
            </div>
          <div className="form-group">
            <label htmlFor="remarks">{copy.columns.remarks}</label>
            <textarea
              id="remarks"
              className="form-input"
              rows={2}
              value={formData.remarks}
              onChange={(e) => handleInputChange("remarks", e.target.value)}
              placeholder="Additional notes"
            />
          </div>

          <div className="form-group">
              <label htmlFor="balanceLimit">
                Balance Limit (Rs.)
                <span style={{ fontWeight: 400, color: "var(--text-3)", marginLeft: 6, fontSize: "12px" }}>
                  — leave empty for no limit
                </span>
              </label>
              <input
                id="balanceLimit"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="form-input"
                value={formData.balanceLimit}
                onChange={(e) => handleInputChange("balanceLimit", e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="e.g. 100000"
              />
            </div>

          <div className="form-group">
              <label htmlFor="status">{copy.columns.status}</label>
              <div className="party-status-options">
                <label className={`party-status-option${formData.status === "ACTIVE" ? " selected active" : ""}`}>
                  <input type="radio" name="status" value="ACTIVE" checked={formData.status === "ACTIVE"} onChange={(e) => handleInputChange("status", e.target.value)} />
                  <span>●</span> Active
                </label>
                <label className={`party-status-option${formData.status === "INACTIVE" ? " selected inactive" : ""}`}>
                  <input type="radio" name="status" value="INACTIVE" checked={formData.status === "INACTIVE"} onChange={(e) => handleInputChange("status", e.target.value)} />
                  <span>●</span> Inactive
                </label>
              </div>
              <select id="status" value={formData.status} onChange={(e) => handleInputChange("status", e.target.value)} hidden>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
          </div>
        </section>

        <div className="form-actions party-form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? "Saving..." : partyId ? "Update Party" : "Create Party"}
          </button>
          {!partyId && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={loading}
              onClick={handleQuickAddParty}
              title="Save this party and immediately start adding another"
            >
              Save &amp; Add Another
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => onNavigate("party-list")} disabled={loading}>{copy.common.cancel}</button>
        </div>
      </form>

      {/* Quick Add Group Modal */}
      {showAddGroup && (
        <div className="modal-overlay" onClick={() => setShowAddGroup(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.stopPropagation();
            }}
          >
            <div className="modal-header">
              <h3>Add New Party Group</h3>
              <button
                type="button"
                className="btn btn-icon close"
                aria-label={copy.common.close}
                onClick={() => setShowAddGroup(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="newGroupName">Group Name <span className="required-mark">*</span></label>
                <input
                  id="newGroupName"
                  type="text"
                  className="form-input"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); void handleAddGroup(); }
                    if (event.key === "Escape") { event.preventDefault(); setShowAddGroup(false); setNewGroupName(""); }
                  }}
                  placeholder="Enter group name"
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAddGroup}
                disabled={!newGroupName.trim()}
              >
                Create Group
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowAddGroup(false);
                  setNewGroupName("");
                }}
              >{copy.common.cancel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

