import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { AgentDetail } from "@/pages/AgentDetail";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { ProfileSettings } from "@/pages/ProfileSettings";
import { useCompany } from "@/context/CompanyContext";
import {
  WorkFolderStoryProvider,
  workFolderAgent,
  workFolderProject,
  workFolderTask,
} from "../fixtures/WorkFolderStoryProvider";
import { WORK_FOLDER_COMPANY } from "../fixtures/workFolders";
import type { WorkFolderScope } from "@paperclipai/shared";

const paths = {
  task: `/PAP/issues/${workFolderTask.identifier}`,
  agent: `/PAP/agents/${workFolderAgent.urlKey}`,
  project: `/PAP/projects/${workFolderProject.urlKey}`,
  user: "/PAP/company/settings/instance/profile",
};
function Page({ scope }: { scope: WorkFolderScope }) {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const onRoute = location.pathname.startsWith(paths[scope]);
  useEffect(() => {
    if (selectedCompanyId !== WORK_FOLDER_COMPANY)
      setSelectedCompanyId(WORK_FOLDER_COMPANY);
  }, [selectedCompanyId, setSelectedCompanyId]);
  useEffect(() => {
    if (!onRoute) navigate(paths[scope], { replace: true });
  }, [scope, onRoute, navigate]);
  if (selectedCompanyId !== WORK_FOLDER_COMPANY || !onRoute) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
          <Route path="projects/:projectId/:tab?" element={<ProjectDetail />} />
          <Route
            path="company/settings/instance/profile"
            element={<ProfileSettings />}
          />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
const meta = {
  title: "Work folders/Pages",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Current production pages after removing the stored-file entry points. Persisted copies do not represent the live sandbox filesystem. Debug inspection of saved files and live sandbox browsing are deferred features. Page mutations are not simulated.",
      },
    },
  },
  args: { scope: "task" },
  argTypes: { scope: { control: false } },
  render: ({ scope }: { scope: WorkFolderScope }) => (
    <WorkFolderStoryProvider key={scope}>
      <Page scope={scope} />
    </WorkFolderStoryProvider>
  ),
} satisfies Meta<{ scope: WorkFolderScope }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TaskPage: Story = { args: { scope: "task" } };
export const AgentPage: Story = { args: { scope: "agent" } };
export const ProjectPage: Story = { args: { scope: "project" } };
export const ProfileSettingsPage: Story = { args: { scope: "user" } };
export const MobileTaskPage: Story = {
  args: { scope: "task" },
  globals: { viewport: { value: "mobile" } },
};
