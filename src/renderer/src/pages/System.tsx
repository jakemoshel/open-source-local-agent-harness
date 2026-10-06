import { DoctorCard, PermissionsCard, ServicesCard, UpdatesCard } from '@/components/SystemPanel'
import { PageHeader } from '@/components/ui'

export function SystemPage() {
  return (
    <>
      <PageHeader title="System" />
      <div className="space-y-6">
        <DoctorCard />
        <UpdatesCard />
        <PermissionsCard />
        <ServicesCard />
      </div>
    </>
  )
}
