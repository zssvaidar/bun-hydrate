import React, { Suspense, useEffect } from "react";
import { Button } from "./src/app/packages/core/button/button";
import Content from "./src/app/Content";

// import {
//     createBrowserRouter,
//     RouterProvider,

//   } from "react-router-dom";
// import {
//   createStaticHandler,
//     createStaticRouter,
//     StaticRouterProvider
// } from "react-router-dom/server";


const DemoComponent = () => {
  // StaticRouterProvider
  const LazyButton = React.lazy(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      default: Button,
    }
  });

  useEffect(() => {
    console.log('mounted');
  }, []);

  return (
    <div>
      <Suspense fallback={<>Waitttt</>}>
        <LazyButton onClick={() => alert('clicked')} />
      </Suspense>
    </div>
  );
}


export class App extends React.Component{
  render () {
    
    // let { query } = createStaticHandler(routes);

    // let context = (await query(
    //   new Request("http://localhost/the/path?the=query#the-hash", {
    //     signal: new AbortController().signal,
    //   })
    // )) as StaticHandlerContext;

    // const staticContext = {};
    // let { query, dataRoutes } = createStaticHandler(routes);
    // let context = query({});
    // let router = createStaticRouter(dataRoutes, context as any);
    // const router = createStaticRouter(routes, context)
    return (
        <React.StrictMode>
          <html lang="en">
            <head>
              <meta charSet="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>Document</title>
            </head>
            <body>
              <h1>Hello, world</h1>
              {/* <StaticRouterProvider router={router} context={context}/> */}
              <Content />
              <Button onClick={() => alert('clicked')} />
              <DemoComponent />
            </body>
          </html>
        </React.StrictMode>
      );
  }
};
