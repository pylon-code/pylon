import * as Layer from "effect/Layer";

/**
 * Wires ProviderService, rollback admission, orchestration and the session
 * reaper into the provider runtime.
 *
 * Orchestration reads rollback admission, and rollback admission needs
 * ProviderService, so ProviderService is built before orchestration exists.
 * Layers are memoized by reference, which makes that early build the instance
 * every consumer shares. ProviderService reads the projection query as an
 * optional service (project browser-access overrides resolve a thread's
 * project through it), so the shared projection infrastructure is provided to
 * it here instead of depending on build order.
 */
export const composeProviderRuntimeLayer = <
  ProviderOut,
  ProviderError,
  ProviderIn,
  ProjectionOut,
  ProjectionError,
  ProjectionIn,
  AdmissionOut,
  AdmissionError,
  AdmissionIn,
  OrchestrationOut,
  OrchestrationError,
  OrchestrationIn,
  ReaperOut,
  ReaperError,
  ReaperIn,
>(layers: {
  readonly provider: Layer.Layer<ProviderOut, ProviderError, ProviderIn>;
  readonly projectionInfrastructure: Layer.Layer<ProjectionOut, ProjectionError, ProjectionIn>;
  readonly rollbackAdmission: Layer.Layer<AdmissionOut, AdmissionError, AdmissionIn>;
  readonly orchestration: Layer.Layer<OrchestrationOut, OrchestrationError, OrchestrationIn>;
  readonly reaper: Layer.Layer<ReaperOut, ReaperError, ReaperIn>;
}) => {
  const provider = layers.provider.pipe(Layer.provide(layers.projectionInfrastructure));
  const rollbackAdmission = layers.rollbackAdmission.pipe(Layer.provide(provider));
  return layers.reaper.pipe(
    Layer.provideMerge(provider),
    Layer.provideMerge(layers.orchestration.pipe(Layer.provideMerge(rollbackAdmission))),
  );
};
