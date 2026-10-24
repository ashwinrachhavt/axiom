import { io } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { isWorkspaceOnboarded } from "@/domains/agents/onboarding";
import { OnboardingInterview } from "./onboarding-interview";

export const metadata = { title: "Meet your agent · Polymath" };

/*
 * First-run onboarding. An onboarded workspace has nothing to do here: the
 * gate below sends it home. The page exists so the interview has a URL the
 * layout gate and e2e can name.
 */
export default async function OnboardingPage() {
  await io();
  const auth = await getAuthContext();
  if (await isWorkspaceOnboarded(auth.workspaceId)) {
    redirect("/alfred");
  }
  return (
    <div className="page-content flex flex-1 items-center justify-center pt-16">
      <OnboardingInterview />
    </div>
  );
}
