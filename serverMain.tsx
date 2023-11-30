// serverMain.tsx
import PageHomeOne from 'app/packages/core/pages/PageHomeOne';
import React from 'react';
import { StaticRouterProvider, createStaticHandler, createStaticRouter } from 'react-router-dom/server';
import Home from './src/app/packages/core/pages/Home/index'
import { json } from 'react-router-dom';
const createFetchRequest = require("./request");

export class App extends React.Component <{context: any, dataRoutes: any}, { context: {}, dataRoutes: {}}>{

  render () {

    let router = createStaticRouter(this.props.dataRoutes, this.props.context);

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
              <StaticRouterProvider router={router} context={this.props.context}/>
              <a href={`/page/1`}>Page One Link</a>
              {/* <Content />
              <Button onClick={() => alert('clicked')} />
              <DemoComponent /> */}
            </body>
          </html>
        </React.StrictMode>
      );
  }
};

const routes = [
  {
    path: "/",
    element: <PageHomeOne pageNum={124} />,
    default: Home,
    loader() {
      return json({ message: "Welcome to React Router!" });
    },
    // Component() {
    //   let data = useLoaderData();
    //   return <h1>'data.message'</h1>;
    // }
  },
];

export const ServerApp = async (host, protocol, req) => {

  let { query, dataRoutes } = createStaticHandler(routes);
  let fetchRequest = createFetchRequest(host, protocol, req);
  let context = await query(fetchRequest);

  return <App context={context} dataRoutes={dataRoutes} />;
};