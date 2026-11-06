import { useEffect, useRef, useState } from "react";
import { api, extractFieldErrors } from "./api";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import type { AutoRerunInterval } from "./types";

interface AutoRerunModalProps {
  onClose: () => void;
}

const INTERVAL_OPTIONS: { value: AutoRerunInterval; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "24h", label: "Every 24 hours" },
];

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function AutoRerunModal({ onClose }: Readonly<AutoRerunModalProps>) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  const [rerunInterval, setRerunInterval] = useState<AutoRerunInterval>("off");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [emailInputError, setEmailInputError] = useState<string | null>(null);

  const loadSettings = async () => {
    setLoading(true);
    setLoadError(null);
    setGeneralError(null);
    try {
      const response = await api.getAutoRerunSettings();
      const data = response.data ?? response;
      if (data.interval && INTERVAL_OPTIONS.some((opt) => opt.value === data.interval)) {
        setRerunInterval(data.interval);
      } else {
        setRerunInterval("off");
      }

      if (Array.isArray(data.recipients)) {
        setRecipients(data.recipients);
      } else {
        setRecipients([]);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load auto re-run settings.";
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleAddRecipient = () => {
    setEmailInputError(null);
    const trimmed = emailInput.trim();

    if (!trimmed) {
      setEmailInputError("Please enter an email address.");
      emailInputRef.current?.focus();
      return;
    }

    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailInputError("Please enter a valid email address (e.g. qa-team@example.com).");
      emailInputRef.current?.focus();
      return;
    }

    if (recipients.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      setEmailInputError("This email address is already added.");
      emailInputRef.current?.focus();
      return;
    }

    setRecipients((prev) => [...prev, trimmed]);
    setEmailInput("");
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.recipients;
      return next;
    });
  };

  const handleRemoveRecipient = (emailToRemove: string) => {
    setRecipients((prev) => prev.filter((email) => email !== emailToRemove));
  };

  const handleSave = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError(null);

    let currentRecipients = [...recipients];
    // If user typed a valid email and forgot to hit 'Add', add it automatically
    const trimmedInput = emailInput.trim();
    if (trimmedInput && EMAIL_REGEX.test(trimmedInput)) {
      if (!currentRecipients.some((r) => r.toLowerCase() === trimmedInput.toLowerCase())) {
        currentRecipients = [...currentRecipients, trimmedInput];
        setRecipients(currentRecipients);
        setEmailInput("");
        setEmailInputError(null);
      }
    }

    // Client-side validation: at least one recipient
    if (currentRecipients.length === 0) {
      const errorMsg = "At least one valid recipient is required before saving.";
      setFieldErrors((prev) => ({
        ...prev,
        recipients: [errorMsg],
      }));
      toast.error(errorMsg);
      return;
    }

    setIsSaving(true);
    setFieldErrors({});

    try {
      const response = await api.saveAutoRerunSettings({
        interval: rerunInterval,
        recipients: currentRecipients,
      });

      const savedData = response.data ?? response;
      if (savedData.interval) setRerunInterval(savedData.interval);
      if (Array.isArray(savedData.recipients)) setRecipients(savedData.recipients);

      toast.success("Auto re-run settings saved successfully.");
    } catch (err: unknown) {
      const extracted = extractFieldErrors(err);
      if (Object.keys(extracted).length > 0) {
        setFieldErrors(extracted);
      }
      const message =
        err instanceof Error ? err.message : "Failed to save auto re-run settings.";
      setGeneralError(message);
      const fieldErrorList = Object.values(extracted).flat();
      const toastMessage =
        fieldErrorList.length > 0
          ? `${message}: ${fieldErrorList.join(", ")}`
          : message;
      toast.error(toastMessage);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <dialog
      open
      className="overlay"
      aria-modal="true"
      aria-labelledby="auto-rerun-modal-title"
    >
      <button type="button" tabIndex={-1} aria-label="Close dialog" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="modal sm">
        <div className="modal-head">
          <div>
            <h2 id="auto-rerun-modal-title">Auto Re-run Settings</h2>
            <p>Run collections on a schedule and email the results to your QA team.</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="icon-btn plain" aria-label="Close">
            <Icon name="x" size={22} />
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="loading">
              <Icon name="loader" size={28} className="spin" />
              Loading auto re-run settings…
            </div>
          )}

          {!loading && loadError && (
            <div className="section">
              <div role="alert" className="banner">
                <Icon name="alert" size={20} />
                <div>
                  <b>Failed to load settings</b>
                  <p className="m-0 mt-1">{loadError}</p>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => void loadSettings()}>
                  Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !loadError && (
            <form id="auto-rerun-form" onSubmit={handleSave}>
              {generalError && (
                <div className="section">
                  <div role="alert" className="alert m-0">{generalError}</div>
                </div>
              )}

              <div className="section">
                <label htmlFor="auto-rerun-interval" className="section-title">Re-run Interval</label>
                <p className="desc">Pick how frequently collections run automatically.</p>
                <div className="sel">
                  <select
                    id="auto-rerun-interval"
                    value={rerunInterval}
                    onChange={(e) => {
                      setRerunInterval(e.target.value as AutoRerunInterval);
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.interval;
                        return next;
                      });
                    }}
                  >
                    {INTERVAL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevDown" size={16} />
                </div>
                {rerunInterval === "off" && (
                  <div className="off-note mt-3.5">
                    <Icon name="clock" size={18} />
                    Collections only run when someone selects Run. Pick an interval to schedule them.
                  </div>
                )}
                {fieldErrors.interval?.map((err) => (
                  <p key={err} className="field-err">{err}</p>
                ))}
              </div>

              <div className="section">
                <div className="section-title">
                  <label htmlFor="recipient-email-input">QA Email Recipients</label>
                  <span className="small muted font-normal">{recipients.length} configured</span>
                </div>
                <p className="desc">Each scheduled run sends a summary and the Newman report to these people.</p>

                <div className="email-row">
                  <label className="search">
                    <Icon name="mail" size={16} />
                    <input
                      ref={emailInputRef}
                      id="recipient-email-input"
                      type="email"
                      value={emailInput}
                      onChange={(e) => {
                        setEmailInput(e.target.value);
                        setEmailInputError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddRecipient();
                        }
                      }}
                      placeholder="name@company.com"
                    />
                  </label>
                  <button type="button" id="add-recipient-btn" className="btn" onClick={handleAddRecipient}>
                    <Icon name="plus" size={16} />
                    Add
                  </button>
                </div>
                {emailInputError && <p className="field-err">{emailInputError}</p>}

                {recipients.length === 0 ? (
                  <div className="note-box">
                    No recipients added yet. At least one recipient email address is required before saving.
                  </div>
                ) : (
                  <div className="emails">
                    {recipients.map((email) => (
                      <span key={email} className="email" title={email}>
                        <span className="av" aria-hidden="true">{email.slice(0, 2)}</span>
                        <span className="t">{email}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveRecipient(email)}
                          title={`Remove ${email}`}
                          aria-label={`Remove recipient ${email}`}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {fieldErrors.recipients?.map((err) => (
                  <p key={err} className="field-err">{err}</p>
                ))}
              </div>
            </form>
          )}
        </div>

        <div className="modal-foot">
          <span className="foot-note">Changes apply to the backend schedule as soon as you save.</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="auto-rerun-form"
            className="btn btn-primary"
            disabled={isSaving || loading || Boolean(loadError)}
          >
            {isSaving ? <Icon name="loader" size={16} className="spin" /> : <Icon name="check" size={16} />}
            <span>{isSaving ? "Saving Settings…" : "Save Settings"}</span>
          </button>
        </div>
      </div>
    </dialog>
  );
}
