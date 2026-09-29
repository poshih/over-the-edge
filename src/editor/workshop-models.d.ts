declare module 'virtual:workshop-models' {
  // The models folder's models this Workshop offers, and where they are delivered from.
  const models: import('./server-models').ServerModels;
  export default models;
}
