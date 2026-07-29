/* ══════════════════════════════════════════════════════════════
   Unlock — AES-256-GCM under a PBKDF2 key, all in WebCrypto.

   The page is public; the data is not. tools/export.py encrypts the metrics
   before they are ever committed, so GitHub Pages only ever serves ciphertext
   and the passphrase never leaves this tab.

   Everything the key derivation needs (salt, iteration count) travels inside
   the file, so the page has nothing to configure and re-encrypting with new
   parameters needs no code change here.

   GCM authenticates as well as encrypts: a wrong passphrase fails the tag
   check and throws, which is exactly the "wrong passphrase" signal — there is
   no separate check to get wrong, and no way to half-decrypt.
   ══════════════════════════════════════════════════════════════ */

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function decrypt(blob, passphrase) {
  if (!blob || blob.v !== 1) throw new Error("unsupported file version");

  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(blob.salt), iterations: blob.iter, hash: "SHA-256" },
    await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase),
                                  "PBKDF2", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Throws on a bad passphrase — the GCM tag is the check.
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(blob.iv) }, key, b64(blob.ct));

  return JSON.parse(new TextDecoder().decode(plain));
}

/* sessionStorage, not localStorage: the passphrase survives a reload while you
   are working, and dies with the tab. A dashboard that stays unlocked forever
   on a shared machine is a worse failure than typing it again. */
const KEY = "remi_dash_pp";

export const remember = pp => { try { sessionStorage.setItem(KEY, pp); } catch {} };
export const recall   = ()  => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
export const forget   = ()  => { try { sessionStorage.removeItem(KEY); } catch {} };
