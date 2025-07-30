import React, { useState, useEffect } from "react";
import net from "../../util/net";

const TopicsVizReport = ({ report_id }) => {
  const [visualizationJobs, setVisualizationJobs] = useState([]);
  const [visualizationsLoading, setVisualizationsLoading] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [delphiTopics, setDelphiTopics] = useState(null);

  useEffect(() => {
    // Fetch visualizations from the delphi endpoint
    net
      .polisGet("/api/v3/delphi/visualizations", {
        report_id: report_id,
      })
      .then((response) => {
        if (response && response.jobs) {
          setVisualizationJobs(response.jobs);
        }
        setVisualizationsLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching visualizations:", err);
        setVisualizationsLoading(false);
      });

    // Fetch topic data from delphi API for topic counts
    net
      .polisGet("/api/v3/delphi", {
        report_id: report_id,
      })
      .then((response) => {
        console.log("Delphi topics response:", response);
        if (response && response.status === "success" && response.runs) {
          setDelphiTopics(response.runs);
        }
      })
      .catch((err) => {
        console.error("Error fetching delphi topics:", err);
      });
  }, [report_id]);

  // Helper function to find the best job to display (prioritize jobs that match topic data)
  const getBestVisualizationJob = () => {
    // if (!visualizationJobs || visualizationJobs.length === 0) {
    //   return null;
    // }

    // // Try to get the job UUID from the latest topic run
    // let topicJobUuid = null;
    // if (delphiTopics) {
    //   const runKeys = Object.keys(delphiTopics);
    //   if (runKeys.length > 0) {
    //     const latestRun = delphiTopics[runKeys[0]];
    //     // Check if any topic has a topic_key with UUID
    //     if (latestRun?.topics_by_layer) {
    //       Object.values(latestRun.topics_by_layer).forEach(layer => {
    //         Object.values(layer).forEach(topic => {
    //           if (topic.topic_key && topic.topic_key.includes('#')) {
    //             topicJobUuid = topic.topic_key.split('#')[0];
    //           }
    //         });
    //       });
    //     }
    //   }
    // }

    // // If we have a topic job UUID, try to find a matching visualization job
    // if (topicJobUuid) {
    //   const matchingJob = visualizationJobs.find(job =>
    //     job.jobId === topicJobUuid && job.status === "COMPLETED"
    //   );
    //   if (matchingJob) {
    //     // For matching jobs, we need to construct the visualization URL even if metadata is missing
    //     if (!matchingJob.visualizations || matchingJob.visualizations.length === 0) {
    //       // Construct the expected visualization URL
    //       const baseUrl = matchingJob.results?.visualization_urls?.interactive;
    //       if (baseUrl) {
    //         matchingJob.visualizations = [{
    //           key: `visualizations/${report_id}/${topicJobUuid}/layer_0_datamapplot.html`,
    //           url: baseUrl,
    //           layerId: 0,
    //           type: "interactive"
    //         }];
    //       }
    //     }
    //     console.log(`Using visualization job ${topicJobUuid} that matches topic data`);
    //     return matchingJob;
    //   }
    // }

    // // Fallback: First, try to find a completed job with visualizations
    // const completedJobWithViz = visualizationJobs.find(job =>
    //   job.status === "COMPLETED" &&
    //   job.visualizations &&
    //   Array.isArray(job.visualizations) &&
    //   job.visualizations.length > 0
    // );

    // if (completedJobWithViz) {
    //   console.log(`Using fallback visualization job ${completedJobWithViz.jobId}`);
    //   return completedJobWithViz;
    // }

    // // If no completed job with visualizations, return the first job
    return visualizationJobs.filter(job => job.visualizations?.length > 0)[0];
  };

  // Get friendly names for different topic granularity levels
  const getTopicLevelName = (layerId, totalLayers) => {
    if (layerId === 0) return "Finer Grained";
    if (layerId === totalLayers - 1) return "Coarse";
    return "Medium";
  };

  const getTopicLevelDescription = (layerId, totalLayers) => {
    if (layerId === 0) return "(Specific insights)";
    if (layerId === totalLayers - 1) return "(Big picture themes)";
    return "(Balanced overview)";
  };

  // Get available layers with topic counts from visualization data and delphi topics
  const getAvailableLayers = () => {
    const bestJob = getBestVisualizationJob();
    if (!bestJob || !bestJob.visualizations) {
      return [];
    }

    const layerMap = new Map();

    // Get layers from visualizations
    bestJob.visualizations
      .filter((vis) => vis && vis.type === "interactive")
      .forEach((vis) => {
        const layerId = vis.layerId;
        if (!layerMap.has(layerId)) {
          layerMap.set(layerId, {
            layerId: layerId,
            topicCount: 1 // Default to 1, will be updated from delphi data
          });
        }
      });

    // Update topic counts from delphi topics data
    if (delphiTopics) {
      // Get the most recent run (first in sorted object)
      const runKeys = Object.keys(delphiTopics);
      if (runKeys.length > 0) {
        const latestRun = delphiTopics[runKeys[0]];
        if (latestRun && latestRun.topics_by_layer) {
          // Update topic counts for each layer
          Object.keys(latestRun.topics_by_layer).forEach((layerId) => {
            const layerIdNum = parseInt(layerId);
            const topicsInLayer = latestRun.topics_by_layer[layerId];
            const topicCount = Object.keys(topicsInLayer).length;

            if (layerMap.has(layerIdNum)) {
              layerMap.set(layerIdNum, {
                layerId: layerIdNum,
                topicCount: topicCount
              });
            }
          });
        }
      }
    }

    return Array.from(layerMap.values()).sort((a, b) => a.layerId - b.layerId);
  };

  const availableLayers = getAvailableLayers();

  // Set initial selected layer when layers are available
  useEffect(() => {
    if (availableLayers.length > 0 && selectedLayer === null) {
      setSelectedLayer(availableLayers[0].layerId);
    }
  }, [availableLayers, selectedLayer]);

  if (visualizationsLoading) {
    return <div className="loading">Loading visualizations...</div>;
  }

  const bestJob = getBestVisualizationJob();

  return (
    <div className="topics-viz-report">
      <style>{`
        .topics-viz-report {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }

        .layer-switcher {
          margin-bottom: 30px;
          padding: 20px;
          background: #f8f9fa;
          border-radius: 8px;
        }

        .layer-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .layer-switcher h3 {
          margin: 0;
          color: #333;
          font-size: 18px;
        }

        .job-status-inline {
          display: flex;
          gap: 15px;
          align-items: center;
          font-size: 14px;
        }

        .switcher-description {
          margin: 0 0 15px 0;
          color: #666;
          font-size: 14px;
        }

        .layer-buttons {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .layer-button {
          padding: 12px 16px;
          border: 2px solid #ddd;
          background: white;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          font-size: 14px;
          font-weight: 500;
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 120px;
        }

        .layer-button:hover {
          border-color: #6060E9;
        }

        .layer-button.active {
          background: #6060E9;
          color: white;
          border-color: #0288d1;
        }

        .layer-description {
          font-size: 12px;
          font-weight: normal;
          opacity: 0.8;
          margin-top: 4px;
        }

        .visualizations-container {
          margin-top: 20px;
        }

        .job-header {
          margin-bottom: 20px;
          padding: 15px;
          background: #f5f5f5;
          border-radius: 6px;
          border-left: 4px solid #6060E9;
        }

        .job-header h3 {
          margin: 0 0 8px 0;
          color: #333;
        }

        .job-meta {
          display: flex;
          gap: 15px;
          align-items: center;
          font-size: 14px;
        }

        .job-status {
          padding: 4px 8px;
          border-radius: 4px;
          font-weight: 500;
          text-transform: uppercase;
          font-size: 12px;
        }

        .status-COMPLETED {
          background: #d4edda;
          color: #155724;
        }

        .status-PENDING {
          background: #fff3cd;
          color: #856404;
        }

        .status-FAILED {
          background: #f8d7da;
          color: #721c24;
        }

        .job-date {
          color: #666;
        }

        .visualizations-grid {
          display: grid;
          gap: 20px;
        }

        .visualization-card {
          border: 1px solid #ddd;
          border-radius: 8px;
          overflow: hidden;
          background: white;
        }

        .visualization-card h4 {
          margin: 0;
          padding: 15px;
          background: #f8f9fa;
          border-bottom: 1px solid #ddd;
          color: #333;
          font-size: 16px;
        }

        .iframe-container {
          position: relative;
          width: 100%;
          height: 800px;
        }

        .iframe-container iframe {
          width: 100%;
          height: 100%;
          border: none;
        }

        .img-container {
          padding: 15px;
        }

        .img-container img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
        }

        .no-visualizations-message {
          text-align: center;
          padding: 40px;
          color: #666;
        }

        .no-visualizations-message p {
          margin: 0 0 10px 0;
          font-size: 16px;
        }

        .loading {
          text-align: center;
          padding: 40px;
          color: #666;
          font-size: 16px;
        }

        @media (max-width: 768px) {
          .topics-viz-report {
            padding: 10px;
          }

          .layer-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 10px;
          }

          .layer-buttons {
            flex-direction: column;
          }

          .layer-button {
            width: 100%;
            min-width: auto;
          }

          .iframe-container {
            height: 600px;
          }
        }
      `}</style>

      {/* Layer Selection */}
      {availableLayers.length > 0 && (
        <div className="layer-switcher">
          <div className="layer-header">
            <h3>Topic Granularity</h3>
            {bestJob && (
              <div className="job-status-inline">
                <span className={`job-status status-${bestJob.status}`}>
                  {bestJob.status}
                </span>
                <span className="job-date">
                  Created: {new Date(bestJob.createdAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <p className="switcher-description">
            Each colored region represents a topic—comments that share similar themes, language, or subject matter.
            Polis 2 uses advanced NLP embeddings and hierarchical clustering to mathematically identify these topics. Choose your preferred level of detail: finer grained shows specific subtopics, while coarse shows broader themes.
          </p>
          <div className="layer-buttons">
            {availableLayers.map((layer) => (
              <button
                key={layer.layerId}
                className={`layer-button ${selectedLayer === layer.layerId ? 'active' : ''}`}
                onClick={() => setSelectedLayer(layer.layerId)}
              >
                {getTopicLevelName(layer.layerId, availableLayers.length)}: {layer.topicCount} Topic{layer.topicCount !== 1 ? 's' : ''}
                <span className="layer-description">
                  {getTopicLevelDescription(layer.layerId, availableLayers.length)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Visualizations */}
      <div className="visualizations-container">
        {bestJob ? (
          <div className="visualization-job">

            {bestJob.visualizations &&
            Array.isArray(bestJob.visualizations) &&
            bestJob.visualizations.length > 0 ? (
            <div className="visualizations-grid">
              {/* Interactive Visualization */}
              {bestJob.visualizations
                .filter((vis) => vis && vis.type === "interactive" && vis.layerId === selectedLayer)
                .map((vis) => (
                  <div key={vis.key} className="visualization-card">
                    <h4>Layer {vis.layerId} Interactive Visualization</h4>
                    <div className="iframe-container">
                      <iframe
                        src={vis.url}
                        title={`Layer ${vis.layerId} visualization`}
                        width="100%"
                        height="800"
                        frameBorder="0"
                      ></iframe>
                    </div>
                  </div>
                ))}

              {/* Static Visualizations */}
              {bestJob.visualizations
                .filter(
                  (vis) =>
                    vis &&
                    (vis.type === "static_png" || vis.type === "presentation_png") &&
                    vis.layerId === selectedLayer
                )
                .map((vis) => (
                  <div key={vis.key} className="visualization-card">
                    <h4>Layer {vis.layerId} Static Visualization</h4>
                    <div className="img-container">
                      <img
                        src={vis.url}
                        alt={`Layer ${vis.layerId} visualization`}
                        width="100%"
                      />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="no-visualizations-message">
              <p>No visualizations available for this job yet.</p>
              <p>Visualizations may take a few minutes to generate.</p>
            </div>
          )}
          </div>
        ) : (
          <div className="no-visualizations-message">
            <p>No visualization jobs found.</p>
            <p>Run a Delphi analysis to generate topic visualizations.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default TopicsVizReport;
