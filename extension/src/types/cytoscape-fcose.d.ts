/**
 * `cytoscape-fcose` ships no types. Its only public surface is the default export handed to
 * `cytoscape.use`, so that is all this declares.
 */
declare module "cytoscape-fcose" {
    import type cytoscape from "cytoscape";
    const extension: cytoscape.Ext;
    export default extension;
}
