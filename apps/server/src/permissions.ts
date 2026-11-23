export const permissions = {
  readMessages: 1 << 0,
  sendMessages: 1 << 1,
  invokeAgents: 1 << 2,
  manageChannels: 1 << 3,
  manageAgents: 1 << 4,
  manageMembers: 1 << 5,
  manageRoles: 1 << 6,
} as const;

export const allPermissions = Object.values(permissions).reduce((all, value) => all | value, 0);
export const defaultMemberPermissions = permissions.readMessages
  | permissions.sendMessages
  | permissions.invokeAgents;

export function includesPermission(grants: number, required: number): boolean {
  return (grants & required) === required;
}
