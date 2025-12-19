export const createEnv = (options: any) => {
  // Return the options object itself so that nested properties like
  // config.server.PORT are accessible as defined in the schema defaults.
  // In a real implementation this would validate and merge process.env.
  return options;
};
