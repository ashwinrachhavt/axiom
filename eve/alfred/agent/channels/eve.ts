// Spike channel: proves a custom AuthFn can resolve an arbitrary inbound
// credential (here: a stand-in for Axiom's Clerk session) instead of only
// Vercel OIDC. Throwaway.
import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const clerkSessionStub: AuthFn<Request> = (request) => {
  const userId = request.headers.get("x-spike-clerk-user-id");
  if (userId === null) return null;
  return {
    attributes: { workspaceId: "spike-workspace" },
    authenticator: "clerk",
    principalId: userId,
    principalType: "user",
  };
};

export default eveChannel({
  auth: [clerkSessionStub, localDev()],
});
