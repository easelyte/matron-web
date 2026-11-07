/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { JournalApiError } from "../api";
import {
    contactCaption,
    isRemoteContact,
    parseContactLink,
    refusalText,
    sortContacts,
    unreachableCaption,
    type Contact,
} from "../contacts";
import { parseMatronHref, remarkBareItemLinks } from "../markdown";

const TOKEN = "A".repeat(43);
const FP = "gs462nr3vwew6cbb2cxzvrtide";
const LINK = `matron://contact?v=1&j=b.example&u=bob&t=${TOKEN}&fp=${FP}`;

const contact = (over: Partial<Contact> = {}): Contact => ({
    id: "ct_1",
    address: "bob@b.example",
    peer_user: "bob",
    peer_journal: "b.example",
    display_name: "bob",
    state: "active",
    key_changed: false,
    ...over,
});

const refused = (status: number, body: Record<string, unknown>): JournalApiError =>
    new JournalApiError("refused", status, String(body.error ?? ""), undefined, body);

describe("parseContactLink", () => {
    it("reads a well-formed invite link", () => {
        expect(parseContactLink(LINK)).toEqual({ journal: "b.example", user: "bob" });
        expect(parseContactLink(`  ${LINK}\n`)).toEqual({ journal: "b.example", user: "bob" });
        expect(parseContactLink(LINK.replace("b.example", "b.example:8443"))).not.toBeNull();
    });

    it("refuses a missing, extra, repeated or malformed field", () => {
        expect(parseContactLink(LINK.replace("v=1", "v=2"))).toBeNull();
        expect(parseContactLink(`${LINK}&x=1`)).toBeNull();
        expect(parseContactLink(`${LINK}&u=eve`)).toBeNull();
        expect(parseContactLink(LINK.replace(`&fp=${FP}`, ""))).toBeNull();
        expect(parseContactLink(LINK.replace(TOKEN, "short"))).toBeNull();
        expect(parseContactLink(LINK.replace(FP, "NOT-A-FINGERPRINT"))).toBeNull();
        expect(parseContactLink(LINK.replace("b.example", "b.example/evil"))).toBeNull();
        expect(parseContactLink("https://b.example/contact")).toBeNull();
        expect(parseContactLink(`${LINK}#x`)).toBeNull();
    });
});

describe("contact rows", () => {
    it("tells a contact on another journal from one on this journal", () => {
        expect(isRemoteContact(contact())).toBe(true);
        expect(isRemoteContact(contact({ address: "carol", peer_journal: null, peer_user: "carol" }))).toBe(false);
    });

    it("says when their journal's key has changed, before anything else", () => {
        expect(contactCaption(contact({ key_changed: true, state: "active" }))).toMatch(/key has changed/);
        expect(contactCaption(contact({ state: "pending_out" }))).toBe("Waiting for them to accept");
        expect(contactCaption(contact())).toBe("");
    });

    it("shows an unreachable line only when the journal sends one", () => {
        expect(unreachableCaption(contact())).toBe("");
        expect(unreachableCaption(contact({ unreachable_since: Date.UTC(2026, 10, 3, 12) }))).toMatch(
            /^Their journal hasn't answered since .+\.$/,
        );
    });

    it("lists active contacts first, then by name", () => {
        const rows = sortContacts([
            contact({ id: "1", display_name: "zed", state: "pending_out" }),
            contact({ id: "2", display_name: "bob" }),
            contact({ id: "3", display_name: "Alice" }),
        ]);
        expect(rows.map((row) => row.id)).toEqual(["3", "2", "1"]);
    });
});

describe("refusalText", () => {
    it.each([
        ["fingerprint_mismatch", 409, /does not match their journal/],
        ["journal_not_allowed", 409, /doesn't allow contacts on that journal/],
        ["own_journal", 409, /from your own journal/],
        ["federation_off", 409, /turned off on your journal/],
        ["too_many_invites", 409, /20 open invites/],
    ])("puts %s in plain words", (code, status, words) => {
        expect(refusalText(refused(status, { error: "conflict", blocked_by: code }))).toMatch(words);
    });

    it("names the inviter's journal when it is not allowed", () => {
        expect(refusalText(refused(409, { error: "conflict", blocked_by: "journal_not_allowed" }), "b.example")).toBe(
            "Your journal doesn't allow contacts on b.example.",
        );
    });

    it("reads the 502 error codes", () => {
        expect(refusalText(refused(502, { error: "unreachable" }))).toBe(
            "Their journal could not be reached. Try again later.",
        );
        expect(refusalText(refused(502, { error: "bad_journal" }))).toBe("That address is not a Matron journal.");
    });

    it("falls back by status", () => {
        expect(refusalText(refused(400, { error: "bad_request" }))).toBe("This is not a valid invite link.");
        expect(refusalText(new JournalApiError("offline", 0))).toMatch(/check your connection/);
        expect(refusalText(new Error("boom"))).toBe("Something went wrong. Try again.");
    });
});

describe("contact links in messages", () => {
    it("is an in-app link", () => {
        expect(parseMatronHref(LINK)).toEqual({ kind: "contact", target: LINK });
        expect(parseMatronHref(`${LINK}&x=1`)).toBeNull();
    });

    it("links a bare invite link in prose, leaving the full stop after it", () => {
        const tree = {
            type: "root",
            children: [{ type: "paragraph", children: [{ type: "text", value: `Here: ${LINK}. Thanks` }] }],
        };
        remarkBareItemLinks()(tree);
        const paragraph = tree.children[0] as { children: Array<{ type: string; url?: string; value?: string }> };
        expect(paragraph.children.map((node) => node.type)).toEqual(["text", "link", "text"]);
        expect(paragraph.children[1].url).toBe(LINK);
        expect(paragraph.children[2].value).toBe(". Thanks");
    });
});
